import { MaterialCommunityIcons } from "@expo/vector-icons";
import { decode as atob, encode as btoa } from "base-64";
import CryptoJS from "crypto-js";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as SQLite from "expo-sqlite";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, remove, update } from "firebase/database";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BleManager, Device } from "react-native-ble-plx";
import { SafeAreaView } from "react-native-safe-area-context";


// --- FIREBASE CONFIG ---
// To apiKey edo DEN einai mystiko (einai public identifier tou project) —
// i prostasia ton dedomenon ginetai apo ta Realtime Database Rules.
const firebaseConfig = {
  apiKey: "AIzaSyAnVt2KN8exCAbhLveH6N62As6QBDljFiU",
  authDomain: "diplomatiki-1391f.firebaseapp.com",
  databaseURL: "https://diplomatiki-1391f-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "diplomatiki-1391f",
  storageBucket: "diplomatiki-1391f.firebasestorage.app",
  messagingSenderId: "723074352514",
  appId: "1:723074352514:web:2eb4b4f7c35ebc8660bb9b",
  measurementId: "G-999XPP2H3P"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp); // reference sto Realtime Database

// Prepei na tairiazoun AKRIVOS me ta UUIDs tou firmware tou ESP32
const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const DATA_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";  // ESP32 -> kinito (notifications)
const AUTH_CHAR_UUID = "8b19e27c-3729-45e0-84c1-65b161405e3f";  // nonce (read) + entoles (write)
const manager = new BleManager();   // ena mono BLE manager gia oli tin efarmogi

// Open (or create) the local database file on the phone
// Etsi ta dedomena epizoun kai an kleisei i efarmogi i xathei to internet
const sqliteDb = SQLite.openDatabaseSync("sensorlog.db");

// O ESP32 stelnei arithmous san strings (gia na kratisei mikro to JSON) —
// edo ta gyrname se pragmatika numbers gia ypologismous kai grafimata.
const normalizePacket = (parsed: any) => ({
  ...parsed,
  t: parseFloat(parsed.t),
  h: parseFloat(parsed.h),
  u: parseFloat(parsed.u),
  l: parseFloat(parsed.l),
});
// deixnei poso fresko einai to teleutaio packet
const relativeTime = (fromMs: number, nowMs: number): string => {
  const diff = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
};
// Unix seconds (opos ta stelnei to RTC) -> anagnosimi imerominia gia to log
const formatDateTime = (unixSeconds: number): string => {
  const date = new Date(unixSeconds * 1000);   // JS douleuei se ms, to ESP32 se s
  const datePart = date.toLocaleDateString([], {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });
  const timePart = date.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${datePart} · ${timePart}`;
};

// --- Cold-chain limits ---
const LIMITS = {
  t: { okMin: 2, okMax: 8, critMin: 8, critMax: 30 },     // °C
  h: { okMin: 30, okMax: 65, critMin: 20, critMax: 75 },  // %RH
  uv: { okMin: 0,    okMax: 2.00, critMin: 0,   critMax: 5.00 },
};

type MetricStatus = "ok" | "warn" | "crit";

//Xromata karton
const STATUS_COLOR: Record<MetricStatus, string> = {
  ok:   "#02006d", // navy — matches the UV/Light cards
  warn: "#FF9500",   // amber — drifting toward the limit
  crit: "#b30c1d",   // red — out of range
};

// Krinei se poia zoni pefti mia timi. Elegxoume PROTA to crit
// giati kathe crit timi einai eksorismou kai ektos tou ok range.
const statusFor = (
  value: number | undefined,
  limit: { okMin: number; okMax: number; critMin: number; critMax: number }
): MetricStatus => {
  if (value == null || isNaN(value)) return "ok"; // xoris data den kokkinizoume tin karta
  if (value < limit.critMin || value > limit.critMax) return "crit";
  if (value < limit.okMin || value > limit.okMax) return "warn";
  return "ok";
};

type ButtonVariant = "primary" | "warning" | "danger" | "overlay";

// Kentriko "theme" ton koumpion — allazeis edo kai allazei se oli tin efarmogi
const BUTTON_VARIANTS: Record<ButtonVariant, { bg: string; text: string }> = {
  primary: { bg: "#02006d", text: "#ffffff" },        // navy — main actions
  warning: { bg: "#FF9500", text: "#ffffff" },        // orange
  danger:  { bg: "#b30c1d", text: "#ffffff" },        // red — destructive (Reset)
  overlay: { bg: "rgba(0,0,0,0.55)", text: "#ffffff" }, // translucent — over the camera
};

// Epanaxrisimopoiisimo koumpi me feedback sto patima (opacity + mikri smikrynsi)
function AppButton({
  title,
  onPress,
  variant = "primary",
  disabled = false,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  style?: object;
}) {
  const v = BUTTON_VARIANTS[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      android_ripple={{ color: "rgba(255,255,255,0.18)" }}
      style={({ pressed }) => [
        buttonStyles.base,
        { backgroundColor: v.bg },
        pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      <Text style={[buttonStyles.text, { color: v.text }]}>{title}</Text>
    </Pressable>
  );
}

const buttonStyles = StyleSheet.create({
  base: {
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
});

export default function Index() {
  // --- STATE ---
  // useState = data pou otan allazoun ksanasxediazoun tin othoni
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);

  const [liveData, setLiveData] = useState<any>(null);
  const [sensorHistory, setSensorHistory] = useState<any[]>([]);
  const credentials = useRef<{ sn: string; key: string } | null>(null);
  const authNonceRef = useRef<string>("");
  const lastSeqRef   = useRef<number>(0);
  const logScrollRef = useRef<ScrollView>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [newestFirst, setNewestFirst] = useState(true);

  // Initialize SQLite table and load saved history when the app first opens
  useEffect(() => {
    // Creates the table if it doesn't already exist.
    // Each row is one sensor reading tied to a station serial number.
    // To time einai PRIMARY KEY -> to idio reading den mporei na grafei dyo fores.
    sqliteDb.execSync(`
      CREATE TABLE IF NOT EXISTS readings (
        time    INTEGER PRIMARY KEY,
        station TEXT,
        t       REAL,
        h       REAL,
        u       REAL,
        l       REAL
      );
    `);
    }, []);  // [] = trexei MIA fora, sto proto mount

    // Re-render once per second to keep the "updated Xs ago" label fresh
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id); // cleanup — alliws to interval synexizei meta to unmount
  }, []);

  // --- 1. FIREBASE SYNC ---
  // ✅ Changed from set() to update() so only new entries are pushed, not the full array
  /*useEffect(() => {
    if (sensorHistory.length > 0 && credentials.current) {
      const stationRef = ref(db, 'stations/' + credentials.current.sn);
      
      // Build an object where each key is the timestamp — Firebase merges these in
      const updates: Record<string, any> = {
        lastUpdate: Math.floor(Date.now() / 1000),
      };
      sensorHistory.forEach(item => {
        updates[`data/${item.time}`] = item;
      });

      update(stationRef, updates).catch((e) => console.log("Firebase Upload Error:", e));
    }
  }, [sensorHistory]);*/


      // --- 3. AUTO-RECONNECT ---
      // Trexei mono an exoume idi credentials (dld exei ginei QR scan).
  useEffect(() => {
    let interval: any;
    if (credentials.current && !connectedDevice && !connecting) {
      interval = setInterval(() => {
        connectToDevice(credentials.current!.sn, credentials.current!.key)
          .catch((e) => console.log("Reconnect attempt failed:", e));
      }, 5000);
    }
    return () => { if (interval) clearInterval(interval); }; // stamata to loop otan sundethoume
  }, [connectedDevice, connecting]);

  // Sto Android to BLE scan apaitei kai location permission (systima apaitisi tou OS)
  const requestBluetoothPermissions = async () => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      return granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  };

  // Oli i diadikasia: permissions -> scan -> connect -> handshake -> subscribe sta data
  const connectToDevice = async (serialNumber: string, secretKey: string) => {
    if (connecting) return; // apotrepei diplo scan an patithei dyo fores
    setConnecting(true);

    // Load this station's history now that we know the serial numbers
    // Etsi o xristis vlepei amesos "cached" data, akoma kai prin sundethei to BLE.
    let saved: any[] = [];
    try {
      saved = sqliteDb.getAllSync(
        "SELECT * FROM readings WHERE station = ? ORDER BY time DESC LIMIT 1500;",
        [serialNumber]
      );
    } catch (e) {
      console.log("SQLite read failed:", e);
    }
    if (saved.length > 0) {
      setSensorHistory(saved as any[]);
    }


    const hasPerms = await requestBluetoothPermissions();
    if (!hasPerms) { setConnecting(false); return; }

    credentials.current = { sn: serialNumber, key: secretKey };// krataei to secret mono sti mnimi

    // An den vrethei o stathmos se 10 deuterolepta, stamatame to scan (den trome mpataria)
    const scanTimeout = setTimeout(() => {
      manager.stopDeviceScan();
      setConnecting(false);
    }, 10000);

    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        clearTimeout(scanTimeout);
        setConnecting(false);
        return;
      }

      // Tairiazoume me to onoma pou kanei advertise to ESP32: ESP-SN-<serial>
      if (device && (device.name === `ESP-SN-${serialNumber}` || device.localName === `ESP-SN-${serialNumber}`)) {
        clearTimeout(scanTimeout);
        manager.stopDeviceScan(); // vrethike — stamata amesos gia oikonomia energeias

        device.connect()
          .then((d) => d.requestMTU(128))   // megalytero MTU = ta JSON packets xoroun se ena frame
          .then((d) => d.discoverAllServicesAndCharacteristics())  // ypoxreotiko prin diavasoume/grapsoume
          .then(async (d) => {
          await new Promise(resolve => setTimeout(resolve, 200));   // mikri pausi — o BLE stack tou Android theli xrono

            // 1. Read the challenge the ESP32 issued on connect
            const nonceHex = atob(
              (await d.readCharacteristicForService(SERVICE_UUID, AUTH_CHAR_UUID)).value ?? ""
            ); // to ble-plx epistrefei base64 — to gyrname se katharo string

            // 2. Sign  nonce:AUTH:timestamp  with the shared secret (secret never leaves the phone)
            const timestamp = Math.floor(Date.now() / 1000).toString(); // SECONDS, oxi ms — to ESP32 to elegxei
            const hmac = CryptoJS.HmacSHA256(`${nonceHex}:AUTH:${timestamp}`, secretKey).toString();

            // 3. Send the signed response
            // To idio timestamp xrisimopoieitai kai gia na rythmisei to RTC tou stathmou
            const payload = `AUTH:${timestamp}:${hmac}`;
            await d.writeCharacteristicWithResponseForService(SERVICE_UUID, AUTH_CHAR_UUID, btoa(payload));
            authNonceRef.current = nonceHex;   
            lastSeqRef.current   = 0;          
            setConnectedDevice(d);
            setConnecting(false);

            // 4. Subscribe — apo edo kai pera to ESP32 mas sprwxnei data monos tou
            d.monitorCharacteristicForService(SERVICE_UUID, DATA_CHAR_UUID, (err, char) => {
              if (err) {
                setConnectedDevice(null); // xathike i sundesi -> energopoieitai to auto-reconnect
                return;
              }
              if (char?.value) {
                try {
                  const packet = atob(char.value);

                  // <json>|<seq>|<tag>  — psaxnoume ta DYO teleutaia '|'
                  // (apo to telos, giati theoritika to JSON body mporei na periexei '|')
                  const p1 = packet.lastIndexOf("|");
                  const p2 = p1 > 0 ? packet.lastIndexOf("|", p1 - 1) : -1;
                  if (p1 < 0 || p2 < 0) { console.log("Unsigned packet — dropped"); return; }

                  const body = packet.slice(0, p2); // to JSON
                  const seq  = parseInt(packet.slice(p2 + 1, p1), 10);
                  const tag  = packet.slice(p1 + 1); // ta prota 16 hex tou HMAC

                  // Ksanaftiaxnoume topika tin ypografi me to idio preimage pou xrisimopoiise to ESP32
                  const expected = CryptoJS
                    .HmacSHA256(`${authNonceRef.current}:${seq}:${body}`, secretKey)
                    .toString()
                    .slice(0, 16);

                  if (expected !== tag)          { console.log("BAD MAC — dropped"); return; } // plasto i alloiomeno
                  if (!(seq > lastSeqRef.current)) { console.log("Replay / out-of-order — dropped"); return; } //idi to eidame
                  lastSeqRef.current = seq;

                  const parsed = normalizePacket(JSON.parse(body));
                  setLastUpdate(Date.now()); 

                  if (parsed.live) {
                    // Live packet: mono gia tin othoni, DEN apothikeuetai pouthena
                    setLiveData({ ...parsed });
                  } else {
                    // Save the new reading to SQLite before updating state
                    // INSERT OR IGNORE -> ta diplotypa (idio timestamp) apla agnoountai
                    sqliteDb.runSync(
                      `INSERT OR IGNORE INTO readings (time, station, t, h, u, l)
                       VALUES (?, ?, ?, ?, ?, ?);`,
                      [parsed.time, serialNumber, parsed.t, parsed.h, parsed.u, parsed.l]
                    );

                    // 2. Upload ONLY this single new reading to Firebase
                    // Me update() grafoume mono to sygkekrimeno paidi tou 'data' — oxi olo to dentro
                    update(ref(db, `stations/${serialNumber}`), {
                    lastUpdate: Math.floor(Date.now() / 1000),
                    [`data/${parsed.time}`]: parsed
                    }).catch(e => console.log("Firebase upload failed", e)); // apotyxia cloud den rixnei tin efarmogi

                    setSensorHistory((prev) => {
                      if (prev.some(item => item.time === parsed.time)) return prev; // idi sti lista
                      return [parsed, ...prev].slice(0, 1500); // Increased limit to match SQLite query
                    });
                  }
                } catch (e) { console.log("JSON Parse Error"); }
              }
            });
          })
          .catch(() => setConnecting(false)); // apotyxia connect/discover — vgainoume apo to loading state
      }
    });
  };

  // Svinei ta panta: mnimi tou stathmou (mesa apo ypografmeni entoli RESET), SQLite kai Firebase
  const resetData = () => {
    Alert.alert("Wipe Station Memory", "Delete all measurements?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset Everything", style: "destructive", onPress: async () => {
          if (connectedDevice && credentials.current) {
            // Read the current (rotated) challenge, then sign  nonce:RESET
            // Kathe entoli theli KAINOURIO nonce — gia auto to ksanadiavazoume edo
            const nonceHex = atob(
              (await connectedDevice.readCharacteristicForService(SERVICE_UUID, AUTH_CHAR_UUID)).value ?? ""
            );
            const hmac = CryptoJS.HmacSHA256(`${nonceHex}:RESET`, credentials.current.key).toString();
            const payload = `RESET:${hmac}`;
            await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, AUTH_CHAR_UUID, btoa(payload));
            
            // Also wipe the local SQLite table for this station
            // (mono autou tou stathmou — alloi stathmoi den epireazontai)
            sqliteDb.runSync(
              "DELETE FROM readings WHERE station = ?;",
              [credentials.current.sn]
            );
            // Wipe Firebase
            const stationRef = ref(db, 'stations/' + credentials.current.sn);
            await remove(stationRef).catch((e) => console.log("Firebase Delete Error:", e));

            setSensorHistory([]); //kathari othoni
            setLiveData(null);
          }
        }
      }
    ]);
  };

   // Elegxomeni apoxorisi: kovei to BLE kai epistrefei stin arxiki othoni.
   // DEN svinei dedomena — mono to state tis othonis.
   const disconnectAndGoHome = () => {
    credentials.current = null;            // stops the auto-reconnect loop
    manager.stopDeviceScan();              // cancels any in-flight scan
    if (connectedDevice) {
      connectedDevice.cancelConnection().catch(() => {}); // tears down the BLE link
    }
    setConnectedDevice(null);
    setLiveData(null);
    setSensorHistory([]);                  // clears the view only — SQLite copy is untouched
    setLastUpdate(null);
    setConnecting(false);
  };

  // Proteraiotita sto live packet· an den yparxei, deixnoume tin pio prosfati apothikeumeni metrisi
  const displayData = liveData || (sensorHistory.length > 0 ? sensorHistory[0] : null);
  const isLive = connectedDevice !== null;
  // Keimeno katastasis kato apo to onoma tou stathmou (LIVE vs CACHED)
  const freshness = isLive
  ? (lastUpdate ? `updated ${relativeTime(lastUpdate, now)}` : "waiting for data…")
  : (sensorHistory.length > 0 ? `last reading ${formatDateTime(sensorHistory[0].time)}` : "no data yet");

  // Min / Avg / Max ana megethos gia olo to session.
  // useMemo -> ksanaypologizetai MONO otan allaksei to sensorHistory, oxi se kathe render.
  const stats = useMemo(() => {
  if (sensorHistory.length === 0) return null;
  // Voithitiki: filtrarei ta mi-arithmitika kai formarei me ti sosti monada
  const calc = (key: string, dp: number, unit: string) => {
    const vals = sensorHistory
      .map((r) => r[key])
      .filter((v) => typeof v === "number" && !isNaN(v)) as number[];
    if (vals.length === 0) return { min: "—", avg: "—", max: "—" };
    const fmt = (n: number) => `${n.toFixed(dp)}${unit}`;
    return {
      min: fmt(Math.min(...vals)),
      avg: fmt(vals.reduce((a, b) => a + b, 0) / vals.length),
      max: fmt(Math.max(...vals)),
    };
  };
  return {
    count: sensorHistory.length,
    rows: [
      { label: "Temperature", ...calc("t", 1, "°C") },
      { label: "Humidity", ...calc("h", 0, "%") },
      { label: "UV index", ...calc("u", 2, "") },
      { label: "Light", ...calc("l", 0, " lx") },
    ],
  };
}, [sensorHistory]);

// Taksinomisi tou log. Antigrafoume me [...] prin to reverse() — to reverse allazei ton pinaka in-place.
const orderedHistory = useMemo(
    () => (newestFirst ? sensorHistory : [...sensorHistory].reverse()),
    [sensorHistory, newestFirst]
  );

  // Gate: xoris adeia kameras den mporoume na diavasoume to QR tou stathmou
  if (!cameraPermission?.granted) return (
    <View style={styles.center}>
      <AppButton title="Allow Camera" onPress={requestCameraPermission} />
    </View>
  );

  // --- UI ---
  // I othoni exei 4 katastaseis: welcome, camera, connecting, telemetry
  return (
    <SafeAreaView style={styles.container}>
      {!isCameraOpen && !connecting && !displayData && (
  <View style={{ flex: 1 }}>

    <View style={[styles.welcomeHeader, { paddingTop: 60, paddingBottom: 40 }]}>
      <View style={styles.welcomeIconCircle}>
        <MaterialCommunityIcons name="hexagon-outline" size={28} color="#ffffff" />
      </View>
      <Text style={styles.welcomeSubtitle}>COLD CHAIN MONITOR</Text>
      <Text style={styles.welcomeTitle}>Station Synchro</Text>
    </View>

    <View style={{ flex: 1, padding: 20, justifyContent: 'space-between' }}>
      <View>
        <Text style={styles.welcomeDescription}>
          Connects to your IoT sensor station via Bluetooth and retrieves all recorded measurements since it was powered on.
        </Text>

        <View style={styles.welcomeRow}>
        <View style={[styles.welcomeIconBadge, { backgroundColor: '#ffffff' }]}>
          <MaterialCommunityIcons name="thermometer" size={20} color="#02006d" />
        </View>
          <Text style={styles.welcomeRowText}>Temperature & Humidity</Text>
        </View>

        <View style={styles.welcomeRow}>
          <View style={[styles.welcomeIconBadge, { backgroundColor: '#ffffff' }]}>
            <MaterialCommunityIcons name="weather-sunny" size={20} color="#02006d" />
          </View>
          <Text style={styles.welcomeRowText}>UV & Light Exposure</Text>
        </View>

        <View style={styles.welcomeRow}>
          <View style={[styles.welcomeIconBadge, { backgroundColor: '#ffffff' }]}>
            <MaterialCommunityIcons name="chart-line" size={20} color="#02006d" />
          </View>
          <Text style={styles.welcomeRowText}>Full session history</Text>
        </View>
      </View>

      <View style={styles.welcomeFooter}>
        <Text style={styles.welcomeFooterText}>Scan the QR code on your station to begin</Text>
        <AppButton title="Scan Station QR Code" onPress={() => setIsCameraOpen(true)} />
      </View>
    </View>

  </View>
)}

{isCameraOpen && (
  <View style={StyleSheet.absoluteFillObject}>
    <CameraView
      style={StyleSheet.absoluteFillObject}
      onBarcodeScanned={({ data }) => {
        setIsCameraOpen(false);
        const parts = data.split(":");
        if (parts.length === 2) connectToDevice(parts[0].trim(), parts[1].trim());
      }}
    />

    {/* Scanning frame overlay */}
    {/* pointerEvents="none" -> to overlay den "trwei" ta aggigmata pros tin kamera */}
    <View style={styles.scanOverlay} pointerEvents="none">
      <View style={styles.scanFrame}>
        <View style={[styles.scanCorner, styles.scanCornerTL]} />
        <View style={[styles.scanCorner, styles.scanCornerTR]} />
        <View style={[styles.scanCorner, styles.scanCornerBL]} />
        <View style={[styles.scanCorner, styles.scanCornerBR]} />
      </View>
      <Text style={styles.scanHint}>Point the camera at the station QR code</Text>
    </View>

    <View style={{ position: 'absolute', top: 50, left: 20 }}>
      <AppButton title="Back" variant="overlay" onPress={() => setIsCameraOpen(false)} />
    </View>
  </View>
)}

      {/* 3. CONNECTING — mono an den exoume idi cached data na deiksoume */}
      {connecting && !displayData && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#02006d" />
          <Text style={{ marginTop: 12, color: '#666' }}>Establishing Data Link...</Text>
        </View>
      )}

      {/* 4. TELEMETRY — i kyria othoni me kartes, statistika kai istoriko */}
      {displayData && (
        <View style={{ flex: 1 }}>
    <View style={styles.telemetryHeader}>
        <Pressable
        onPress={disconnectAndGoHome}
        hitSlop={10}
        android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
        style={styles.headerBackBtn}
      >
        <MaterialCommunityIcons name="chevron-left" size={26} color="#ffffff" />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={styles.telemetryStation}>Station {credentials.current?.sn ?? "—"}</Text>
        <Text style={styles.telemetryFreshness} numberOfLines={1}>{freshness}</Text>
      </View>
      {/* Pill LIVE (prasino) / CACHED (gkri) analoga me tin katastasi tis sundesis */}
      <View style={[styles.statusPill, isLive ? styles.statusPillLive : styles.statusPillCached]}>
        <View style={[styles.statusDot, isLive ? styles.statusDotLive : styles.statusDotCached]} />
        <Text style={[styles.statusPillText, isLive ? styles.statusTextLive : styles.statusTextCached]}>
          {isLive ? "LIVE" : "CACHED"}
        </Text>
      </View>
    </View>

        <ScrollView style={styles.scroll}>
          <Text style={styles.header}>Live Telemetry</Text>

          {/* Kartes metriseon — to xroma tou fontou bgainei apo to statusFor() */}
          <View style={styles.row}>
            <View style={[styles.card, { backgroundColor: STATUS_COLOR[statusFor(displayData.t, LIMITS.t)] }]}>
            <Text style={styles.label}>TEMPERATURE</Text>
            <Text style={styles.val}>{displayData.t?.toFixed(1)} °C</Text>
          </View>
            <View style={[styles.card, { backgroundColor: STATUS_COLOR[statusFor(displayData.h, LIMITS.h)] }]}>
              <Text style={styles.label}>HUMIDITY</Text>
              <Text style={styles.val}>{displayData.h?.toFixed(0)} %</Text>
            </View>
          </View>

          <View style={styles.row}>
            <View style={[styles.card, { backgroundColor: STATUS_COLOR[statusFor(displayData.u, LIMITS.uv)] }]}>
              <Text style={styles.label}>UV INDEX</Text>
              <Text style={styles.val}>{displayData.u?.toFixed(2)}</Text>
            </View>
            <View style={[styles.card, { backgroundColor: '#02006d' }]}>
              <Text style={styles.label}>LIGHT (LUX)</Text>
              <Text style={styles.val}>{displayData.l?.toFixed(0)}</Text>
            </View>
          </View>

          {/* Pinakas MIN / AVG / MAX gia olo to session */}
          {stats && (
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <Text style={styles.summaryTitle}>Session Summary</Text>
              <Text style={styles.summaryCount}>{stats.count} readings</Text>
            </View>

          {/* Grammi me tis kefalides ton stilon (to proto keli menei keno gia to label) */}
          <View style={styles.summaryRow}>
            <Text style={styles.summaryMetricLabel}></Text>
            <Text style={styles.summaryColHead}>MIN</Text>
            <Text style={styles.summaryColHead}>AVG</Text>
            <Text style={styles.summaryColHead}>MAX</Text>
          </View>

          {stats.rows.map((r) => (
            <View key={r.label} style={styles.summaryRow}>
              <Text style={styles.summaryMetricLabel}>{r.label}</Text>
              <Text style={styles.summaryCell}>{r.min}</Text>
              <Text style={[styles.summaryCell, styles.summaryCellAvg]}>{r.avg}</Text>
              <Text style={styles.summaryCell}>{r.max}</Text>
            </View>
          ))}
        </View>
      )}
          {/* Istoriko metriseon me toggle taksinomisis */}
            <View style={styles.logBox}>
            <View style={styles.logBoxHeader}>
              <Text style={styles.logHeaderTitle}>MEASUREMENT HISTORY</Text>
              <Pressable
                onPress={() => {
                  setNewestFirst((v) => !v);
                  logScrollRef.current?.scrollTo({ y: 0, animated: true }); // paei pano meta tin antistrofi
                }}
                hitSlop={8}
                android_ripple={{ color: 'rgba(2,0,109,0.12)', borderless: true }}
                style={styles.sortToggle}
              >
                <MaterialCommunityIcons name="swap-vertical" size={16} color="#02006d" />
                <Text style={styles.sortToggleText}>{newestFirst ? "Newest" : "Oldest"}</Text>
              </Pressable>
            </View>

            {sensorHistory.length === 0 ? (
              <View style={styles.logEmpty}>
                <Text style={styles.logEmptyText}>No stored readings yet</Text>
              </View>
            ) : (
              // nestedScrollEnabled: xreiazetai giati einai ScrollView mesa se ScrollView
              <ScrollView ref={logScrollRef} style={styles.logScroll} nestedScrollEnabled showsVerticalScrollIndicator>
                {orderedHistory.map((item, i) => (
                  <View key={i} style={styles.logRow}>
                    <Text style={styles.logTime}>{formatDateTime(item.time)}</Text>
                    <Text style={styles.logValues}>
                      Temp: {item.t?.toFixed(1)}°C | Hum: {item.h?.toFixed(0)}% | UV: {item.u?.toFixed(2)} | Lux: {item.l?.toFixed(1)}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>

          <View style={{ marginVertical: 15 }}>
            <AppButton title="Reset Data" variant="danger" onPress={resetData} />
          </View>

          {/* Keno sto telos gia na min "kollaei" to koumpi sto kato akro tis othonis */}
          <View style={{ height: 60 }} />
        </ScrollView>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  welcomeCard: { backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', borderWidth: 0.5, borderColor: '#ddd' },
  welcomeHeader: { backgroundColor: '#02006d', padding: 32, alignItems: 'center' },
  welcomeIconCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  welcomeSubtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 11, letterSpacing: 2, marginBottom: 6 },
  welcomeTitle: { color: 'white', fontSize: 20, fontWeight: '500' },
  welcomeDescription: { fontSize: 13, color: '#666', textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  welcomeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#dbdbdb', borderRadius: 8, padding: 14, marginBottom: 10 },  welcomeIconBadge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  welcomeRowText: { fontSize: 16, fontWeight: '500', color: '#333', flex: 1, textAlign: 'center' },
  welcomeFooter: { borderTopWidth: 0.5, borderTopColor: '#eee', paddingTop: 16, marginTop: 6 },
  welcomeFooterText: { fontSize: 11, color: '#999', textAlign: 'center', marginBottom: 14 },
  container: { flex: 1, backgroundColor: "#F8F9FA" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  scroll: { flex: 1, padding: 15 },
  header: { fontSize: 22, fontWeight: "bold", textAlign: "center", marginVertical: 15, color: '#333' },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  card: { width: '48%', padding: 18, borderRadius: 15, elevation: 2 },
  label: { color: "white", fontSize: 11, fontWeight: "bold" },
  val: { color: "white", fontSize: 24, fontWeight: "bold", marginTop: 4 },
  logRow: { backgroundColor: "white", padding: 14, borderRadius: 10, marginBottom: 8, elevation: 1 },
  logTime: { fontWeight: 'bold', color: '#333', marginBottom: 4, fontSize: 13 },
  logValues: { color: '#555', fontSize: 12 },

  telemetryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#02006d', paddingHorizontal: 18, paddingVertical: 14 },
  telemetryStation: { color: '#fff', fontSize: 18, fontWeight: '600' },
  telemetryFreshness: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 },
  statusPillLive: { backgroundColor: 'rgba(40,167,69,0.22)' },
  statusPillCached: { backgroundColor: 'rgba(255,255,255,0.15)' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotLive: { backgroundColor: '#3ddc84' },
  statusDotCached: { backgroundColor: '#9aa0a6' },
  statusPillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  statusTextLive: { color: '#9fe9bd' },
  statusTextCached: { color: '#e8eaed' },

  summaryCard: { backgroundColor: '#fff', borderRadius: 15, padding: 16, marginVertical: 10, elevation: 2 },
  summaryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  summaryTitle: { fontSize: 16, fontWeight: 'bold', color: '#333', textTransform: 'uppercase' },
  summaryCount: { fontSize: 12, color: '#999' },
  summaryRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  summaryMetricLabel: { flex: 1.4, fontSize: 13, color: '#555' },
  summaryColHead: { flex: 1, fontSize: 11, color: '#aaa', fontWeight: '600', textAlign: 'right' },
  summaryCell: { flex: 1, fontSize: 14, color: '#333', textAlign: 'right', fontWeight: '500' },
  summaryCellAvg: { color: '#02006d', fontWeight: '700' },

  scanOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 240, height: 240 },
  scanCorner: { position: 'absolute', width: 40, height: 40, borderColor: '#ffffff' },
  scanCornerTL: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 10 },
  scanCornerTR: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 10 },
  scanCornerBL: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 10 },
  scanCornerBR: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 10 },
  scanHint: { color: '#ffffff', fontSize: 15, fontWeight: '500', marginTop: 20, textAlign: 'center', paddingHorizontal: 30, textShadowColor: 'rgba(0,0,0,0.75)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  
  headerBackBtn: { marginRight: 8, padding: 2 },
  logBox: { backgroundColor: '#ECEEF2', borderRadius: 12, padding: 8, borderWidth: 1, borderColor: '#E1E4EA', marginVertical: 10},

  logScroll: { height: 380 },
  logBoxHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 8 },
  logHeaderTitle: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  sortToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#fff', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#E1E4EA' },
  sortToggleText: { fontSize: 12, fontWeight: '600', color: '#02006d' },
  logEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 30 },
  logEmptyText: { color: '#999', fontSize: 13 },
});