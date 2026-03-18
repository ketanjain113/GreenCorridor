import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { io } from "socket.io-client";
import LiveEtaCountdown from "./LiveEtaCountdown";

const BACKEND_BASE_URL = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:4000";

const HOSPITAL = {
  name: "MY Hospital, Indore",
  coord: [22.7281, 75.8685],
};

const ROUTES = {
  alpha: {
    name: "Route Alpha",
    points: [
      [22.7196, 75.8577],
      [22.7209, 75.8602],
      [22.7224, 75.8629],
      [22.724, 75.8655],
      [22.7257, 75.8669],
      [22.7271, 75.8677],
      [22.7281, 75.8685],
    ],
    intersections: [
      { id: "A", pointIndex: 1, coord: [22.7209, 75.8602] },
      { id: "B", pointIndex: 3, coord: [22.724, 75.8655] },
      { id: "C", pointIndex: 5, coord: [22.7271, 75.8677] },
    ],
  },
  beta: {
    name: "Route Beta",
    points: [
      [22.7169, 75.8555],
      [22.7186, 75.8592],
      [22.7205, 75.8624],
      [22.7221, 75.8647],
      [22.7244, 75.8664],
      [22.7266, 75.8675],
      [22.7281, 75.8685],
    ],
    intersections: [
      { id: "A", pointIndex: 1, coord: [22.7186, 75.8592] },
      { id: "B", pointIndex: 2, coord: [22.7205, 75.8624] },
      { id: "D", pointIndex: 4, coord: [22.7244, 75.8664] },
    ],
  },
};

const STORY_PRESETS = {
  normalFlow: {
    label: "Normal Flow",
    routeKey: "alpha",
    startIndex: 0,
    speedKmh: 52,
    focus: "corridor",
    signalOverrides: {
      A: { signal: "Red", eta: 24 },
      B: { signal: "Red", eta: 48 },
      C: { signal: "Red", eta: 72 },
    },
    alerts: ["Emergency monitoring active", "Normal urban traffic profile"],
  },
  heavyTraffic: {
    label: "Heavy Traffic",
    routeKey: "beta",
    startIndex: 1,
    speedKmh: 28,
    focus: "signal",
    signalOverrides: {
      A: { signal: "Red", eta: 18 },
      B: { signal: "Red", eta: 26 },
      D: { signal: "Red", eta: 38 },
    },
    alerts: ["Heavy congestion detected", "Priority corridor commands being queued"],
  },
  closeEta: {
    label: "Close ETA",
    routeKey: "alpha",
    startIndex: 4,
    speedKmh: 61,
    focus: "signal",
    signalOverrides: {
      C: { signal: "Green", eta: 6 },
      B: { signal: "Red", eta: 18 },
    },
    alerts: ["Emergency vehicle approaching intersection", "Signal pre-green activated"],
  },
  incidentAhead: {
    label: "Incident Ahead",
    routeKey: "beta",
    startIndex: 2,
    speedKmh: 35,
    focus: "camera",
    signalOverrides: {
      A: { signal: "Green", eta: 9 },
      B: { signal: "Red", eta: 16 },
      D: { signal: "Red", eta: 28 },
    },
    alerts: ["Incident reported near next corridor node", "Reroute and lane clearance advisory issued"],
  },
};

const BASE_TRAFFIC = [
  { id: "A", vehicles: 12, traffic: "Low" },
  { id: "B", vehicles: 35, traffic: "High" },
  { id: "C", vehicles: 18, traffic: "Moderate" },
  { id: "D", vehicles: 9, traffic: "Low" },
];

function nowTime() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function formatDistance(distanceMeters) {
  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }

  return `${(distanceMeters / 1000).toFixed(distanceMeters >= 10000 ? 0 : 1)} km`;
}

function formatDuration(durationSeconds) {
  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  return `${minutes} min`;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getStepInstruction(step) {
  if (!step) {
    return "Follow the highlighted route";
  }

  const type = step.maneuver?.type;
  const modifier = step.maneuver?.modifier;
  const road = step.name ? ` on ${step.name}` : "";

  if (type === "arrive") {
    return "Arrive at your destination";
  }

  if (type === "depart") {
    return `Head out${road}`;
  }

  if (type === "roundabout") {
    return `Enter the roundabout${road}`;
  }

  if (modifier === "left") {
    return `Turn left${road}`;
  }

  if (modifier === "right") {
    return `Turn right${road}`;
  }

  if (modifier === "slight left") {
    return `Keep left${road}`;
  }

  if (modifier === "slight right") {
    return `Keep right${road}`;
  }

  if (modifier === "uturn") {
    return "Make a U-turn";
  }

  return `Continue${road}`;
}

function getStepGlyph(step) {
  const type = step?.maneuver?.type;
  const modifier = step?.maneuver?.modifier;

  if (type === "arrive") return "◎";
  if (type === "roundabout") return "◌";
  if (modifier === "left") return "↰";
  if (modifier === "right") return "↱";
  if (modifier === "slight left") return "↖";
  if (modifier === "slight right") return "↗";
  if (modifier === "uturn") return "↺";
  return "↑";
}

function getCameraCoord(points, pointIndex) {
  return points[Math.max(pointIndex - 1, 0)] || points[0];
}

const VEHICLE_VISUALS = {
  ambulance: { label: "Ambulance", glyph: "🚑", color: "#ef4444" },
  police: { label: "Police", glyph: "🚓", color: "#1d4ed8" },
  fire_truck: { label: "Fire Truck", glyph: "🚒", color: "#f97316" },
};

function getVehicleVisual(vehicleType) {
  return VEHICLE_VISUALS[vehicleType] || VEHICLE_VISUALS.ambulance;
}

function createVehicleIcon(vehicleType) {
  const visual = getVehicleVisual(vehicleType);
  return L.divIcon({
    className: "emergency-vehicle-icon-wrap",
    html: `<span class="emergency-vehicle-icon" style="background:${visual.color}">${visual.glyph}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function interpolateCoord(fromCoord, toCoord, progress) {
  return [
    fromCoord[0] + (toCoord[0] - fromCoord[0]) * progress,
    fromCoord[1] + (toCoord[1] - fromCoord[1]) * progress,
  ];
}

function easeOutCubic(progress) {
  return 1 - (1 - progress) ** 3;
}

function normalizeSignal(rawSignal) {
  return String(rawSignal || "RED").toUpperCase() === "GREEN" ? "Green" : "Red";
}

function parseEtaSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function getDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function resolveIntersectionIdFromUpdate(update, intersections) {
  if (!update || !Array.isArray(intersections) || intersections.length === 0) {
    return null;
  }

  if (update.intersection) {
    const direct = String(update.intersection);
    return intersections.some((item) => item.id === direct) ? direct : null;
  }

  if (!Array.isArray(update.position) || update.position.length < 2) {
    return null;
  }

  const [x, y] = update.position;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    return null;
  }

  const asCoord = [Number(x), Number(y)];
  let closest = intersections[0];
  let closestDistance = getDistance(closest.coord, asCoord);

  for (const intersection of intersections.slice(1)) {
    const dist = getDistance(intersection.coord, asCoord);
    if (dist < closestDistance) {
      closest = intersection;
      closestDistance = dist;
    }
  }

  return closest?.id || null;
}

function App() {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);
  const emergencyMarkerRef = useRef(null);
  const emergencyMarkerCoordRef = useRef(null);
  const emergencyMarkerRafRef = useRef(null);
  const signalSocketRef = useRef(null);
  const navMapElementRef = useRef(null);
  const navMapRef = useRef(null);
  const navBaseLayerRef = useRef(null);
  const navRouteLayerRef = useRef(null);
  const navSearchTimerRef = useRef(null);
  const navInitRef = useRef(false);
  const navStartCoordRef = useRef(null);
  const webcamVideoRef = useRef(null);
  const webcamCanvasRef = useRef(null);
  const webcamSocketRef = useRef(null);
  const webcamStreamRef = useRef(null);
  const webcamFrameTimerRef = useRef(null);
  const webcamReconnectTimerRef = useRef(null);
  const webcamReconnectAttemptsRef = useRef(0);
  const webcamFrameUrlRef = useRef(null);
  const uploadPreviewUrlRef = useRef(null);
  const outputVideoUrlRef = useRef(null);
  const outputVideoElementRef = useRef(null);
  const policePopupTimerRef = useRef(null);
  const etaAlertTimerRef = useRef(null);
  const etaAlertCooldownRef = useRef(0);
  const etaCriticalActiveRef = useRef(false);
  const webcamIntentionalStopRef = useRef(false);
  const MAX_WEBCAM_RECONNECT_ATTEMPTS = 6;
  const [theme, setTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem("traffic-dashboard-theme");
    return savedTheme === "dark" ? "dark" : "light";
  });

  const [selectedRoute, setSelectedRoute] = useState("alpha");
  const [activeStoryPreset, setActiveStoryPreset] = useState("normalFlow");
  const [demoModeEnabled, setDemoModeEnabled] = useState(false);
  const [demoModeSaving, setDemoModeSaving] = useState(false);
  const [vehicleType] = useState("ambulance");
  const [emergencyVehicleIndex, setEmergencyVehicleIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(true);
  const [camerasActive] = useState(true);
  const [speedKmh, setSpeedKmh] = useState(52);
  const [logs, setLogs] = useState([{ time: nowTime(), text: "System initialized" }]);
  const [alerts, setAlerts] = useState(["Emergency monitoring active"]);
  const [navOpen, setNavOpen] = useState(false);
  const [navSearchQuery, setNavSearchQuery] = useState("");
  const [navSearchResults, setNavSearchResults] = useState([]);
  const [navSearchLoading, setNavSearchLoading] = useState(false);
  const [navDestination, setNavDestination] = useState(null);
  const [navRoute, setNavRoute] = useState(null);
  const [navNavigating, setNavNavigating] = useState(false);
  const [navUserLocation, setNavUserLocation] = useState(null);
  const [navGpsLoading, setNavGpsLoading] = useState(false);
  const [navGpsError, setNavGpsError] = useState("");
  const [navNearbyHospitals, setNavNearbyHospitals] = useState([]);
  const [navNearbyHospitalsLoading, setNavNearbyHospitalsLoading] = useState(false);
  const [navSideTabOpen, setNavSideTabOpen] = useState(true);
  const [webcamRunning, setWebcamRunning] = useState(false);
  const [webcamConnecting, setWebcamConnecting] = useState(false);
  const [webcamError, setWebcamError] = useState("");
  const [webcamPredictedFrameUrl, setWebcamPredictedFrameUrl] = useState("");
  const [videoUploadFile, setVideoUploadFile] = useState(null);
  const [videoUploadPreviewUrl, setVideoUploadPreviewUrl] = useState("");
  const [videoPredictionUrl, setVideoPredictionUrl] = useState("");
  const [videoPredicting, setVideoPredicting] = useState(false);
  const [videoPredictError, setVideoPredictError] = useState("");
  const [policePopup, setPolicePopup] = useState({ visible: false, message: "" });
  const [etaAlertBanner, setEtaAlertBanner] = useState({ visible: false, message: "" });
  const [presentationFocus, setPresentationFocus] = useState("corridor");
  const [liveSignalByIntersection, setLiveSignalByIntersection] = useState({});
  const [liveVehicleUpdate, setLiveVehicleUpdate] = useState(null);

  const route = ROUTES[selectedRoute];
  const currentCoord = route.points[emergencyVehicleIndex];
  const liveCurrentCoord = useMemo(() => {
    const position = liveVehicleUpdate?.position;
    if (!Array.isArray(position) || position.length < 2) {
      return currentCoord;
    }

    const lat = Number(position[0]);
    const lon = Number(position[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return currentCoord;
    }

    return [lat, lon];
  }, [currentCoord, liveVehicleUpdate]);

  const signalRows = useMemo(() => {
    const stepSeconds = 12;
    return route.intersections.map((intersection) => {
      const distanceSteps = intersection.pointIndex - emergencyVehicleIndex;
      const etaSeconds = Math.max(distanceSteps * stepSeconds, 0);
      const signal = etaSeconds > 0 && etaSeconds <= 30 ? "Green" : "Red";

      return {
        intersection: intersection.id,
        signal,
        eta: etaSeconds === 0 ? "Passed" : `${etaSeconds} sec`,
        etaSeconds,
      };
    });
  }, [emergencyVehicleIndex, route]);

  const displaySignalRows = useMemo(() => {
    return signalRows.map((row) => {
      const override = liveSignalByIntersection[row.intersection];
      if (!override) {
        return row;
      }
      return {
        ...row,
        signal: override.signal,
        eta: override.eta ?? row.eta,
      };
    });
  }, [liveSignalByIntersection, signalRows]);

  const nearestNextSignal = useMemo(() => {
    const next = displaySignalRows.find((row) => row.etaSeconds > 0);
    return next ? next.intersection : null;
  }, [displaySignalRows]);

  const cameras = useMemo(() => {
    return [1, 2, 3].map((cameraId, index) => {
      const detectWindow = Math.abs(emergencyVehicleIndex - (index + 1) * 2) <= 1;
      const detected = camerasActive && detectWindow;
      const confidence = detected ? 92 + ((emergencyVehicleIndex + index) % 6) : 0;
      return {
        id: `Camera_${cameraId}`,
        detected,
        confidence,
      };
    });
  }, [emergencyVehicleIndex, camerasActive]);

  const routeCameraNodes = useMemo(() => {
    return route.intersections.map((intersection, index) => {
      const camera = cameras[index] || { id: `Camera_${index + 1}`, detected: false, confidence: 0 };
      return {
        ...camera,
        targetSignal: intersection.id,
        coord: getCameraCoord(route.points, intersection.pointIndex),
      };
    });
  }, [cameras, route]);

  const analytics = useMemo(() => {
    const greenCount = displaySignalRows.filter((row) => row.signal === "Green").length;
    return {
      delayReduced: "32%",
      coordinatedSignals: `${greenCount}/${displaySignalRows.length}`,
      responseSaved: "2.5 minutes",
    };
  }, [displaySignalRows]);

  const emergencyVehicleEtaMinutes = Math.max((route.points.length - 1 - emergencyVehicleIndex) * 0.55, 0.5).toFixed(1);
  const navPrimaryStep = useMemo(() => {
    if (!navRoute?.steps?.length) {
      return null;
    }

    return navRoute.steps.find((step) => step.maneuver?.type !== "depart") || navRoute.steps[0];
  }, [navRoute]);

  const trafficDensity = BASE_TRAFFIC.map((item) => {
    const variance = ((emergencyVehicleIndex + item.id.charCodeAt(0)) % 5) - 2;
    const vehicles = Math.max(item.vehicles + variance, 3);
    const traffic = vehicles > 28 ? "High" : vehicles > 15 ? "Moderate" : "Low";
    return { ...item, vehicles, traffic };
  });

  const revealDelay = (ms) => ({ "--reveal-delay": `${ms}ms` });
  const detectedCameraCount = cameras.filter((camera) => camera.detected).length;
  const greenSignalCount = displaySignalRows.filter((row) => row.signal === "Green").length;
  const nextSignalLabel = nearestNextSignal ? `Intersection ${nearestNextSignal}` : "Final corridor stretch";
  const activeDetection = cameras.find((camera) => camera.detected) || null;
  const upcomingSignal = displaySignalRows.find((row) => row.etaSeconds > 0) || null;
  const upcomingEtaSeconds = useMemo(() => {
    const wsEta = parseEtaSeconds(liveVehicleUpdate?.eta);
    if (wsEta !== null) {
      return wsEta;
    }

    if (!upcomingSignal) {
      return null;
    }

    if (typeof upcomingSignal.etaSeconds === "number" && Number.isFinite(upcomingSignal.etaSeconds)) {
      return upcomingSignal.etaSeconds;
    }

    return parseEtaSeconds(upcomingSignal.eta);
  }, [liveVehicleUpdate, upcomingSignal]);
  const activeCameraNode = routeCameraNodes.find((camera) => camera.id === activeDetection?.id) || null;
  const upcomingIntersection = route.intersections.find((intersection) => intersection.id === upcomingSignal?.intersection) || null;
  const corridorProgress = Math.round((emergencyVehicleIndex / Math.max(route.points.length - 1, 1)) * 100);
  const modelFeedLabel = webcamRunning
    ? "Live webcam model output"
    : webcamConnecting
      ? "Connecting to live model"
      : videoPredictionUrl
        ? "Processed video evidence"
        : "Model ready for demo input";
  const modelFeedHint = webcamPredictedFrameUrl
    ? "Current AI inference frame from the live detection pipeline."
    : videoPredictionUrl
      ? "Annotated output from uploaded video processed by the model."
      : "Use Start Webcam AI or upload a clip below to show the actual detection model during the presentation.";

  const demoPhase = useMemo(() => {
    if (!isRunning && emergencyVehicleIndex >= route.points.length - 1) {
      return 3;
    }

    if (upcomingSignal && upcomingSignal.signal === "Green") {
      return 2;
    }

    if (activeDetection && upcomingSignal) {
      return 1;
    }

    return 0;
  }, [activeDetection, emergencyVehicleIndex, isRunning, route.points.length, upcomingSignal]);

  useEffect(() => {
    setLiveSignalByIntersection({});
  }, [selectedRoute]);

  useEffect(() => {
    if (signalSocketRef.current) {
      signalSocketRef.current.disconnect();
      signalSocketRef.current = null;
    }

    const socket = io(BACKEND_BASE_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 300,
      reconnectionAttempts: 10,
    });

    const onUpdate = (payload) => {
      const intersectionId = resolveIntersectionIdFromUpdate(payload, route.intersections);
      if (!intersectionId) {
        return;
      }

      setLiveVehicleUpdate(payload);

      setLiveSignalByIntersection((prev) => ({
        ...prev,
        [intersectionId]: {
          signal: normalizeSignal(payload.signal),
          eta: payload.eta ?? null,
        },
      }));
    };

    socket.on("update", onUpdate);
    socket.on("vehicle:update", onUpdate);
    signalSocketRef.current = socket;

    return () => {
      socket.off("update", onUpdate);
      socket.off("vehicle:update", onUpdate);
      socket.disconnect();
      signalSocketRef.current = null;
    };
  }, [route.intersections]);

  const demoFlow = [
    {
      title: "Emergency Vehicle Detected",
      detail: activeDetection
        ? `${activeDetection.id} detected emergency class (${activeDetection.confidence}% confidence)`
        : "Waiting for camera detection window",
    },
    {
      title: "ETA Computed for Next Signal",
      detail: upcomingSignal
        ? `ETA to intersection ${upcomingSignal.intersection}: ${upcomingSignal.eta}`
        : "No upcoming signal remaining on this route",
    },
    {
      title: "Pre-Green Command Issued",
      detail: upcomingSignal
        ? `Intersection ${upcomingSignal.intersection} receives priority green command`
        : "Priority command finished for all intersections",
    },
    {
      title: "Corridor Cleared to Hospital",
      detail: !isRunning
        ? "Emergency vehicle reached destination with signal priority"
        : `Live monitoring active, ETA ${emergencyVehicleEtaMinutes} min`,
    },
  ];

  const activateScenario = (routeKey) => {
    setSelectedRoute(routeKey);
    setEmergencyVehicleIndex(0);
    setSpeedKmh(52);
    setIsRunning(true);
    setPresentationFocus("corridor");
    setLogs((prev) => [{ time: nowTime(), text: "Scenario replay started for judges" }, ...prev].slice(0, 10));
    setAlerts(["Demo mode active: detection -> ETA -> signal pre-green", "Emergency monitoring active"]);
  };

  const replayScenario = () => {
    activateScenario(selectedRoute);
  };

  const applyStoryPreset = async (presetKey) => {
    const preset = STORY_PRESETS[presetKey];
    if (!preset) {
      return;
    }

    setActiveStoryPreset(presetKey);
    setSelectedRoute(preset.routeKey);
    setEmergencyVehicleIndex(Math.max(0, preset.startIndex));
    setSpeedKmh(preset.speedKmh);
    setIsRunning(true);
    setPresentationFocus(preset.focus);
    setAlerts(preset.alerts);
    setLogs((prev) => [{ time: nowTime(), text: `${preset.label} preset activated` }, ...prev].slice(0, 10));

    const seededCoord = ROUTES[preset.routeKey]?.points?.[Math.max(0, preset.startIndex)] || route.points[0];
    const presetEtas = Object.values(preset.signalOverrides || {})
      .map((item) => parseEtaSeconds(item?.eta))
      .filter((value) => typeof value === "number");
    const seededEta = presetEtas.length ? Math.min(...presetEtas) : null;
    const seededSignal = seededEta !== null && seededEta < 10 ? "GREEN" : "RED";
    setLiveVehicleUpdate({
      vehicle: "ambulance",
      eta: seededEta,
      signal: seededSignal,
      position: seededCoord,
    });

    // Route change clears signal overrides first; re-apply preset overrides after that render cycle.
    window.setTimeout(() => {
      setLiveSignalByIntersection(preset.signalOverrides);
    }, 0);

    if (!demoModeEnabled && !demoModeSaving) {
      setDemoModeSaving(true);
      try {
        const response = await fetch(`${BACKEND_BASE_URL}/api/demo-mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });

        if (response.ok) {
          const payload = await response.json();
          setDemoModeEnabled(Boolean(payload?.enabled));
        }
      } catch {
        // Ignore demo toggle failure; preset still applies to local narrative.
      } finally {
        setDemoModeSaving(false);
      }
    }
  };

  const toggleDemoMode = async () => {
    if (demoModeSaving) {
      return;
    }

    const nextEnabled = !demoModeEnabled;
    setDemoModeSaving(true);
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/api/demo-mode`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: nextEnabled }),
      });

      if (!response.ok) {
        throw new Error("Could not switch demo mode");
      }

      const payload = await response.json();
      setDemoModeEnabled(Boolean(payload?.enabled));
      setLogs((prev) => [
        { time: nowTime(), text: payload?.enabled ? "Demo mode enabled" : "Demo mode disabled" },
        ...prev,
      ].slice(0, 10));
    } catch (error) {
      setLogs((prev) => [
        { time: nowTime(), text: error?.message || "Failed to switch demo mode" },
        ...prev,
      ].slice(0, 10));
    } finally {
      setDemoModeSaving(false);
    }
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("traffic-dashboard-theme", theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    fetch(`${BACKEND_BASE_URL}/api/demo-mode`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled && payload) {
          setDemoModeEnabled(Boolean(payload.enabled));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    mapRef.current = L.map(mapElementRef.current, {
      zoomControl: false,
    }).setView(route.points[0], 14);

    L.control.zoom({ position: "bottomright" }).addTo(mapRef.current);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapRef.current);

    layerGroupRef.current = L.layerGroup().addTo(mapRef.current);
  }, [route.points]);

  useEffect(() => {
    if (!mapRef.current || !layerGroupRef.current) {
      return;
    }

    const group = layerGroupRef.current;
    group.clearLayers();

    L.polyline(route.points, {
      color: "#0e7be6",
      weight: 6,
      opacity: 0.8,
    }).addTo(group);

    const traversedRoute = route.points.slice(0, Math.max(emergencyVehicleIndex + 1, 1));
    if (traversedRoute.length > 1) {
      L.polyline(traversedRoute, {
        color: "#22c55e",
        weight: 6,
        opacity: 0.9,
      }).addTo(group);
    }

    route.intersections.forEach((intersection) => {
      const row = displaySignalRows.find((item) => item.intersection === intersection.id);
      const color = row && row.signal === "Green" ? "#1cae70" : "#e45252";
      L.circleMarker(intersection.coord, {
        radius: 9,
        color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip(`Signal ${intersection.id}: ${row ? row.signal : "Red"}`, {
          permanent: false,
        })
        .addTo(group);
    });

    routeCameraNodes.forEach((camera) => {
      const cameraColor = camera.detected ? "#f59e0b" : "#355c7d";
      L.circleMarker(camera.coord, {
        radius: camera.detected ? 8 : 6,
        color: "#ffffff",
        fillColor: cameraColor,
        fillOpacity: 0.95,
        weight: 2,
      })
        .bindTooltip(
          `${camera.id}${camera.detected ? ` detecting emergency vehicle (${camera.confidence}%)` : ` monitoring signal ${camera.targetSignal}`}`,
          { permanent: false }
        )
        .addTo(group);
    });

    if (activeCameraNode) {
      L.circle(activeCameraNode.coord, {
        radius: 140,
        color: "#f59e0b",
        fillColor: "#fbbf24",
        fillOpacity: 0.12,
        weight: 1.5,
        dashArray: "6 6",
      }).addTo(group);
    }

    if (activeCameraNode && upcomingIntersection) {
      L.polyline([activeCameraNode.coord, upcomingIntersection.coord], {
        color: "#f59e0b",
        weight: 4,
        opacity: 0.9,
        dashArray: "8 10",
      })
        .bindTooltip(`ETA sent from ${activeCameraNode.id} to signal ${upcomingIntersection.id}`)
        .addTo(group);
    }

    if (upcomingIntersection) {
      L.polyline([liveCurrentCoord, upcomingIntersection.coord], {
        color: "#22c55e",
        weight: 5,
        opacity: 0.8,
      }).addTo(group);
    }

    L.circleMarker(HOSPITAL.coord, {
      radius: 10,
      color: "#0f2238",
      fillColor: "#ffd43b",
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(HOSPITAL.name)
      .addTo(group);
  }, [activeCameraNode, displaySignalRows, emergencyVehicleIndex, liveCurrentCoord, route, routeCameraNodes, upcomingIntersection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !liveCurrentCoord) {
      return;
    }

    const visual = getVehicleVisual(vehicleType);
    const nextCoord = liveCurrentCoord;
    const marker = emergencyMarkerRef.current;

    if (!marker) {
      const created = L.marker(nextCoord, {
        icon: createVehicleIcon(vehicleType),
        zIndexOffset: 1200,
      })
        .bindTooltip(`${visual.label} (live)`, { direction: "top" })
        .addTo(map);
      emergencyMarkerRef.current = created;
      emergencyMarkerCoordRef.current = nextCoord;
      map.panTo(nextCoord, { animate: true, duration: 0.7 });
      return;
    }

    marker.setIcon(createVehicleIcon(vehicleType));
    marker.setTooltipContent(`${visual.label} (live)`);

    const previousCoord = emergencyMarkerCoordRef.current || nextCoord;
    if (previousCoord[0] === nextCoord[0] && previousCoord[1] === nextCoord[1]) {
      return;
    }

    if (emergencyMarkerRafRef.current) {
      window.cancelAnimationFrame(emergencyMarkerRafRef.current);
      emergencyMarkerRafRef.current = null;
    }

    const animationDurationMs = 900;
    const startedAt = performance.now();

    const animate = (now) => {
      const elapsed = now - startedAt;
      const linearProgress = Math.min(elapsed / animationDurationMs, 1);
      const easedProgress = easeOutCubic(linearProgress);
      const interpolated = interpolateCoord(previousCoord, nextCoord, easedProgress);
      marker.setLatLng(interpolated);

      if (linearProgress < 1) {
        emergencyMarkerRafRef.current = window.requestAnimationFrame(animate);
        return;
      }

      emergencyMarkerCoordRef.current = nextCoord;
      emergencyMarkerRafRef.current = null;
    };

    emergencyMarkerRafRef.current = window.requestAnimationFrame(animate);
    map.panTo(nextCoord, { animate: true, duration: 0.9 });
  }, [liveCurrentCoord, vehicleType]);

  useEffect(() => {
    return () => {
      if (emergencyMarkerRafRef.current) {
        window.cancelAnimationFrame(emergencyMarkerRafRef.current);
      }
      if (emergencyMarkerRef.current) {
        emergencyMarkerRef.current.remove();
        emergencyMarkerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (presentationFocus === "camera" && activeCameraNode) {
      map.flyTo(activeCameraNode.coord, 16, { duration: 1 });
      return;
    }

    if (presentationFocus === "signal" && upcomingIntersection) {
      map.flyTo(upcomingIntersection.coord, 16, { duration: 1 });
      return;
    }

    if (presentationFocus === "hospital") {
      map.flyTo(HOSPITAL.coord, 16, { duration: 1 });
      return;
    }

    if (presentationFocus === "corridor") {
      map.flyToBounds(L.latLngBounds(route.points), {
        padding: [40, 40],
        maxZoom: 15,
        duration: 1,
      });
    }
  }, [activeCameraNode, presentationFocus, route.points, upcomingIntersection]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const timer = window.setInterval(() => {
      setEmergencyVehicleIndex((current) => {
        const next = current + 1;
        setSpeedKmh(46 + Math.floor(Math.random() * 11));

        if (next >= route.points.length) {
          setIsRunning(false);
          setLogs((prev) => [{ time: nowTime(), text: "Emergency Vehicle reached destination" }, ...prev].slice(0, 10));
          setAlerts(["Emergency Vehicle reached MY Hospital, Indore", "Route completed successfully"]);
          return current;
        }

        const passedIntersection = route.intersections.find((item) => item.pointIndex === next);
        if (passedIntersection) {
          setLogs((prev) =>
            [
              { time: nowTime(), text: `Emergency Vehicle passed intersection ${passedIntersection.id}` },
              { time: nowTime(), text: `Signal ${passedIntersection.id} changed to GREEN` },
              ...prev,
            ].slice(0, 10)
          );
        }

        return next;
      });
    }, 1200);

    return () => window.clearInterval(timer);
  }, [isRunning, route]);

  useEffect(() => {
    if (!nearestNextSignal || !isRunning) {
      return;
    }

    setAlerts([
      `Emergency vehicle approaching intersection ${nearestNextSignal}`,
      "Clear the lane and prioritize green corridor",
    ]);
  }, [nearestNextSignal, isRunning]);

  useEffect(() => {
    const isCriticalEta = typeof upcomingEtaSeconds === "number" && upcomingEtaSeconds > 0 && upcomingEtaSeconds < 10;

    if (!isCriticalEta) {
      etaCriticalActiveRef.current = false;
      return;
    }

    if (etaCriticalActiveRef.current) {
      return;
    }

    const now = Date.now();
    const cooldownMs = 12000;
    if (now - etaAlertCooldownRef.current < cooldownMs) {
      etaCriticalActiveRef.current = true;
      return;
    }

    etaCriticalActiveRef.current = true;
    etaAlertCooldownRef.current = now;
    setEtaAlertBanner({
      visible: true,
      message: "⚠ Emergency vehicle approaching — clear lane",
    });

    if (etaAlertTimerRef.current) {
      window.clearTimeout(etaAlertTimerRef.current);
    }

    etaAlertTimerRef.current = window.setTimeout(() => {
      setEtaAlertBanner((prev) => ({ ...prev, visible: false }));
    }, 4500);
  }, [upcomingEtaSeconds]);

  useEffect(() => {
    const revealItems = document.querySelectorAll("[data-reveal]");
    if (!revealItems.length) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          } else {
            entry.target.classList.remove("is-visible");
          }
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -40px 0px" }
    );

    revealItems.forEach((item) => observer.observe(item));

    return () => observer.disconnect();
  }, []);

  // Nav map lifecycle
  useEffect(() => {
    if (!navOpen) {
      if (navMapRef.current) {
        navMapRef.current.remove();
        navMapRef.current = null;
        navBaseLayerRef.current = null;
        navRouteLayerRef.current = null;
        navInitRef.current = false;
      }
      setNavDestination(null);
      setNavRoute(null);
      setNavNavigating(false);
      setNavGpsError("");
      setNavSideTabOpen(true);
      return;
    }
    const tid = setTimeout(() => {
      const el = navMapElementRef.current;
      if (!el || navInitRef.current) return;
      navInitRef.current = true;
      const startCoord = navStartCoordRef.current || [22.7196, 75.8577];
      const map = L.map(el, { zoomControl: false }).setView(startCoord, 14);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      const baseLayer = L.layerGroup().addTo(map);
      const routeLayer = L.layerGroup().addTo(map);
      navMapRef.current = map;
      navBaseLayerRef.current = baseLayer;
      navRouteLayerRef.current = routeLayer;
      map.on("click", (e) => {
        const coord = [e.latlng.lat, e.latlng.lng];
        setNavDestination({ name: `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`, coord });
        setNavSearchQuery("");
        setNavSearchResults([]);
      });
    }, 80);
    return () => clearTimeout(tid);
  }, [navOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draw nav start / GPS markers
  useEffect(() => {
    const baseLayer = navBaseLayerRef.current;
    if (!navOpen || !baseLayer) return;
    baseLayer.clearLayers();

    const startCoord = navUserLocation?.coord || navStartCoordRef.current || [22.7196, 75.8577];

    L.circleMarker(startCoord, {
      radius: 12,
      color: "#ffffff",
      fillColor: navUserLocation ? "#0e7be6" : "#ef4444",
      fillOpacity: 1,
      weight: 3,
    })
      .bindTooltip(navUserLocation ? "Current GPS Location" : "Emergency Vehicle (Start)", {
        permanent: true,
        direction: "top",
      })
      .addTo(baseLayer);

    if (navUserLocation) {
      L.circle(startCoord, {
        radius: 36,
        color: "#0e7be6",
        fillColor: "#60a5fa",
        fillOpacity: 0.18,
        weight: 1.5,
      }).addTo(baseLayer);
    }
  }, [navOpen, navUserLocation]);

  // Nearby hospitals — fetched once when nav opens
  useEffect(() => {
    if (!navOpen) return;

    const center = navUserLocation?.coord || navStartCoordRef.current || [22.7196, 75.8577];
    const [lat, lon] = center;
    const r = 0.35;
    const viewbox = `${lon - r},${lat + r},${lon + r},${lat - r}`;

    setNavNearbyHospitalsLoading(true);
    fetch(
      `https://nominatim.openstreetmap.org/search?q=hospital&countrycodes=in&format=json&limit=5&viewbox=${viewbox}&bounded=1`,
      { headers: { "Accept-Language": "en-US,en;q=0.9" } }
    )
      .then((r) => r.json())
      .then((data) => setNavNearbyHospitals(data))
      .catch(() => setNavNearbyHospitals([]))
      .finally(() => setNavNearbyHospitalsLoading(false));
  }, [navOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nav search (Nominatim — India biased)
  useEffect(() => {
    clearTimeout(navSearchTimerRef.current);
    if (!navSearchQuery.trim()) {
      setNavSearchResults([]);
      return;
    }
    const tid = setTimeout(async () => {
      setNavSearchLoading(true);
      const center = navUserLocation?.coord || navStartCoordRef.current || [22.7196, 75.8577];
      const [lat, lon] = center;
      const r = 2.5;
      const viewbox = `${lon - r},${lat + r},${lon + r},${lat - r}`;
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(navSearchQuery)}&countrycodes=in&viewbox=${viewbox}&format=json&limit=6`,
          { headers: { "Accept-Language": "en-US,en;q=0.9" } }
        );
        const data = await res.json();
        setNavSearchResults(data);
      } catch {
        setNavSearchResults([]);
      } finally {
        setNavSearchLoading(false);
      }
    }, 500);
    navSearchTimerRef.current = tid;
    return () => clearTimeout(tid);
  }, [navSearchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch route via OSRM when destination is set
  useEffect(() => {
    if (!navDestination) return;
    const start = navUserLocation?.coord || navStartCoordRef.current || [22.7196, 75.8577];
    const [startLat, startLon] = start;
    const [endLat, endLon] = navDestination.coord;
    setNavRoute(null);
    fetch(
      `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson&steps=true`
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.routes && data.routes[0]) {
          const coords = data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
          setNavRoute({
            coords,
            distance: data.routes[0].distance,
            duration: data.routes[0].duration,
            steps: data.routes[0].legs?.[0]?.steps || [],
          });
        }
      })
      .catch(() => {});
  }, [navDestination, navUserLocation]);

  // Draw route on nav map
  useEffect(() => {
    const routeLayer = navRouteLayerRef.current;
    const map = navMapRef.current;
    if (!map || !routeLayer) return;
    routeLayer.clearLayers();
    if (!navRoute || !navDestination) return;
    L.polyline(navRoute.coords, { color: "#0e7be6", weight: 6, opacity: 0.85 }).addTo(routeLayer);
    L.circleMarker(navDestination.coord, {
      radius: 12,
      color: "#ffffff",
      fillColor: "#1fa86e",
      fillOpacity: 1,
      weight: 3,
    })
      .bindTooltip("Destination", { permanent: true, direction: "top" })
      .addTo(routeLayer);
    const allPts = [navUserLocation?.coord || navStartCoordRef.current || navRoute.coords[0], navDestination.coord];
    map.fitBounds(L.latLngBounds(allPts), { padding: [60, 60] });
  }, [navRoute, navDestination, navUserLocation]);

  useEffect(() => {
    const map = navMapRef.current;
    if (!map || !navRoute || !navNavigating) {
      return;
    }

    const focusSlice = navRoute.coords.slice(0, Math.min(18, navRoute.coords.length));
    if (focusSlice.length > 1) {
      map.flyToBounds(L.latLngBounds(focusSlice), {
        paddingTopLeft: [24, 110],
        paddingBottomRight: [24, 220],
        maxZoom: 16,
        duration: 1.1,
      });
      return;
    }

    map.flyTo(focusSlice[0], 16, { duration: 1.1 });
  }, [navNavigating, navRoute]);

  const requestCurrentLocation = () => {
    if (!("geolocation" in navigator)) {
      setNavGpsError("GPS is not supported on this device/browser.");
      return;
    }

    setNavGpsLoading(true);
    setNavGpsError("");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coord = [position.coords.latitude, position.coords.longitude];
        navStartCoordRef.current = coord;
        setNavUserLocation({
          coord,
          accuracy: Math.round(position.coords.accuracy || 0),
        });

        if (navMapRef.current) {
          navMapRef.current.flyTo(coord, 15, { duration: 1.1 });
        }

        setNavGpsLoading(false);
      },
      () => {
        setNavGpsLoading(false);
        setNavGpsError("Location access was denied or unavailable.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  };

  const clearWebcamFrameTimer = () => {
    if (webcamFrameTimerRef.current) {
      window.clearInterval(webcamFrameTimerRef.current);
      webcamFrameTimerRef.current = null;
    }
  };

  const clearWebcamReconnectTimer = () => {
    if (webcamReconnectTimerRef.current) {
      window.clearTimeout(webcamReconnectTimerRef.current);
      webcamReconnectTimerRef.current = null;
    }
  };

  const startFramePushLoop = () => {
    clearWebcamFrameTimer();
    webcamFrameTimerRef.current = window.setInterval(() => {
      const canvasElement = webcamCanvasRef.current;
      const video = webcamVideoRef.current;
      const ws = webcamSocketRef.current;

      if (!canvasElement || !video || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!video.videoWidth || !video.videoHeight) {
        return;
      }

      canvasElement.width = video.videoWidth;
      canvasElement.height = video.videoHeight;
      const context = canvasElement.getContext("2d");
      if (!context) {
        return;
      }

      context.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);
      canvasElement.toBlob(
        (blob) => {
          if (!blob || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          ws.send(blob);
        },
        "image/jpeg",
        0.82
      );
    }, 220);
  };

  const stopWebcamInference = (intentionalStop = true) => {
    webcamIntentionalStopRef.current = intentionalStop;
    clearWebcamReconnectTimer();
    clearWebcamFrameTimer();
    webcamReconnectAttemptsRef.current = 0;

    if (webcamSocketRef.current) {
      webcamSocketRef.current.close();
      webcamSocketRef.current = null;
    }

    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }

    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamStreamRef.current = null;
    }

    setWebcamConnecting(false);
    setWebcamRunning(false);
  };

  const connectWebcamSocket = () => {
    const wsBase = BACKEND_BASE_URL.replace("http://", "ws://").replace("https://", "wss://");
    const socket = new WebSocket(`${wsBase}/ws/live`);
    socket.binaryType = "arraybuffer";
    webcamSocketRef.current = socket;

    socket.onopen = () => {
      clearWebcamReconnectTimer();
      webcamReconnectAttemptsRef.current = 0;
      setWebcamConnecting(false);
      setWebcamRunning(true);
      setWebcamError("");
      startFramePushLoop();
      setLogs((prev) => [{ time: nowTime(), text: "Live webcam AI detection started" }, ...prev].slice(0, 10));
    };

    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        return;
      }

      const imageBlob = new Blob([event.data], { type: "image/jpeg" });
      const frameUrl = URL.createObjectURL(imageBlob);

      if (webcamFrameUrlRef.current) {
        URL.revokeObjectURL(webcamFrameUrlRef.current);
      }

      webcamFrameUrlRef.current = frameUrl;
      setWebcamPredictedFrameUrl(frameUrl);
    };

    socket.onerror = () => {
      if (!webcamIntentionalStopRef.current) {
        setWebcamError("Connection issue detected. Reconnecting...");
      }
    };

    socket.onclose = () => {
      webcamSocketRef.current = null;
      clearWebcamFrameTimer();

      const shouldReconnect = !webcamIntentionalStopRef.current && !!webcamStreamRef.current;
      if (!shouldReconnect) {
        setWebcamConnecting(false);
        setWebcamRunning(false);
        return;
      }

      const nextAttempt = webcamReconnectAttemptsRef.current + 1;
      webcamReconnectAttemptsRef.current = nextAttempt;

      if (nextAttempt > MAX_WEBCAM_RECONNECT_ATTEMPTS) {
        stopWebcamInference(false);
        setWebcamError("Connection to AI backend is unstable. Please click Start Webcam AI to retry.");
        return;
      }

      const delayMs = Math.min(6000, 600 * 2 ** (nextAttempt - 1));
      setWebcamRunning(false);
      setWebcamConnecting(true);
      setWebcamError(`Connection dropped. Reconnecting (${nextAttempt}/${MAX_WEBCAM_RECONNECT_ATTEMPTS})...`);

      clearWebcamReconnectTimer();
      webcamReconnectTimerRef.current = window.setTimeout(() => {
        if (!webcamIntentionalStopRef.current && webcamStreamRef.current) {
          connectWebcamSocket();
        }
      }, delayMs);
    };
  };

  const startWebcamInference = async () => {
    if (webcamRunning || webcamConnecting) {
      return;
    }

    webcamIntentionalStopRef.current = false;
    webcamReconnectAttemptsRef.current = 0;
    clearWebcamReconnectTimer();
    setWebcamError("");
    setWebcamConnecting(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      webcamStreamRef.current = stream;

      const videoElement = webcamVideoRef.current;
      if (!videoElement) {
        throw new Error("Webcam video element not found");
      }

      videoElement.srcObject = stream;
      await videoElement.play();
      connectWebcamSocket();
    } catch (error) {
      stopWebcamInference();
      setWebcamError(error?.message || "Unable to start webcam AI detection");
    }
  };

  const onVideoFileSelect = (event) => {
    const file = event.target.files?.[0] || null;
    setVideoUploadFile(file);
    setVideoPredictError("");

    if (uploadPreviewUrlRef.current) {
      URL.revokeObjectURL(uploadPreviewUrlRef.current);
      uploadPreviewUrlRef.current = null;
    }

    if (!file) {
      setVideoUploadPreviewUrl("");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    uploadPreviewUrlRef.current = previewUrl;
    setVideoUploadPreviewUrl(previewUrl);
  };

  const showPolicePopup = (message) => {
    setPolicePopup({ visible: true, message });

    if (policePopupTimerRef.current) {
      window.clearTimeout(policePopupTimerRef.current);
    }

    policePopupTimerRef.current = window.setTimeout(() => {
      setPolicePopup((prev) => ({ ...prev, visible: false }));
    }, 5000);
  };

  const dismissEtaAlertBanner = () => {
    if (etaAlertTimerRef.current) {
      window.clearTimeout(etaAlertTimerRef.current);
      etaAlertTimerRef.current = null;
    }
    setEtaAlertBanner((prev) => ({ ...prev, visible: false }));
  };

  const runVideoPrediction = async () => {
    if (!videoUploadFile || videoPredicting) {
      return;
    }

    setVideoPredicting(true);
    setVideoPredictError("");

    try {
      const formData = new FormData();
      formData.append("video", videoUploadFile);

      const response = await fetch(`${BACKEND_BASE_URL}/api/predict/video/file`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let detail = "Video prediction failed";
        try {
          const errorBody = await response.json();
          detail = errorBody?.details || errorBody?.message || detail;
        } catch {
          // Ignore parse errors and keep generic detail message.
        }
        throw new Error(detail);
      }

      const trafficAlertTriggered = response.headers.get("x-traffic-alert") === "1";
      const maxVehicleCount = Number(response.headers.get("x-vehicle-count-max") || 0);
      const alertThreshold = Number(response.headers.get("x-alert-threshold") || 0);

      const predictedVideoBlob = await response.blob();
      const predictedVideoUrl = URL.createObjectURL(predictedVideoBlob);

      if (outputVideoUrlRef.current) {
        URL.revokeObjectURL(outputVideoUrlRef.current);
      }

      outputVideoUrlRef.current = predictedVideoUrl;
      setVideoPredictionUrl(predictedVideoUrl);

      // Force media element to reload the new blob URL in all browsers.
      const outputVideoEl = outputVideoElementRef.current;
      if (outputVideoEl) {
        outputVideoEl.load();
      }

      setLogs((prev) => [{ time: nowTime(), text: "Uploaded video processed by AI backend" }, ...prev].slice(0, 10));

      if (trafficAlertTriggered) {
        showPolicePopup(`Vehicle count ${maxVehicleCount} exceeded threshold ${alertThreshold}`);
        setLogs((prev) => [
          {
            time: nowTime(),
            text: `Traffic alert triggered (count ${maxVehicleCount} > threshold ${alertThreshold})`,
          },
          ...prev,
        ].slice(0, 10));
      } else {
        setLogs((prev) => [
          {
            time: nowTime(),
            text: `Traffic normal (count ${maxVehicleCount}, threshold ${alertThreshold})`,
          },
          ...prev,
        ].slice(0, 10));
      }
    } catch (error) {
      setVideoPredictError(error?.message || "Could not process uploaded video");
    } finally {
      setVideoPredicting(false);
    }
  };

  useEffect(() => {
    return () => {
      stopWebcamInference();

      if (webcamFrameUrlRef.current) {
        URL.revokeObjectURL(webcamFrameUrlRef.current);
      }

      if (uploadPreviewUrlRef.current) {
        URL.revokeObjectURL(uploadPreviewUrlRef.current);
      }

      if (outputVideoUrlRef.current) {
        URL.revokeObjectURL(outputVideoUrlRef.current);
      }

      if (policePopupTimerRef.current) {
        window.clearTimeout(policePopupTimerRef.current);
      }

      if (etaAlertTimerRef.current) {
        window.clearTimeout(etaAlertTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      <div className="ambient-bg" aria-hidden="true" />
      <nav className="container section-nav" aria-label="Section Navigation">
        <div className="section-nav-left">
          <a href="#" className="nav-brand" aria-label="Green Corridor home">
            <span className="nav-brand-logo-shell" aria-hidden="true">
              <span className="nav-brand-mark">GC</span>
            </span>
          </a>

          <div className="section-nav-links">
            <a href="#maps-section">Maps</a>
            <a href="#detection-intelligence-section">Detection and Decision Intelligence</a>
            <a href="#impact-analytics-section">System Impact Analytics</a>
          </div>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
        >
          {theme === "light" ? "Enable Dark Mode" : "Enable Light Mode"}
        </button>
      </nav>

      {policePopup.visible ? (
        <aside className="police-popup" role="status" aria-live="polite">
          <strong>Police Alert</strong>
          <span>{policePopup.message}</span>
        </aside>
      ) : null}

      {etaAlertBanner.visible ? (
        <aside className="eta-alert-banner" role="alert" aria-live="assertive">
          <span>{etaAlertBanner.message}</span>
          <button
            type="button"
            className="eta-alert-dismiss"
            onClick={dismissEtaAlertBanner}
            aria-label="Dismiss emergency ETA alert"
          >
            Dismiss
          </button>
        </aside>
      ) : null}

      <header className="header container reveal is-visible" data-reveal style={revealDelay(0)}>
        <div>
          <p className="eyebrow">City Emergency Coordination Dashboard</p>
          <h1 className="brand-title">
            <span className="brand-main">Green Corridor</span>
            <span className="brand-sub">Live Emergency Vehicle Priority Management</span>
          </h1>
          <p className="subtitle">
            Real-time tracking, automatic signal control, camera AI detection, and decision intelligence for emergency corridors.
          </p>
        </div>
      </header>

      <section className="container reveal is-visible" data-reveal style={revealDelay(20)}>
        <section className="panel map-panel">
          <div className="panel-head">
            <h2>Live Map Tracking</h2>
            <span className="route-chip">{route.name}</span>
            <button
              type="button"
              className="nav-open-btn"
              onClick={() => {
                navStartCoordRef.current = currentCoord;
                setNavOpen(true);
              }}
            >
              ⛶ Navigate
            </button>
          </div>
          <div className="map-area" ref={mapElementRef} />
          <div className="map-caption">
            Emergency vehicle position, route path, intersection signal states, and hospital destination are updated continuously.
          </div>
        </section>
      </section>

      <main className="page-sections">
        <section className="scroll-section" id="maps-section">
          <div className="container section-block">
            <div className="section-head reveal" data-reveal style={revealDelay(40)}>
              <p className="section-kicker">Section 01</p>
              <h2>Live Green Corridor</h2>
              <p className="section-subtitle">Real-time emergency route tracking, signal adaptation, and live emergency vehicle status.</p>
            </div>

            <section className="solution-demo reveal" data-reveal style={revealDelay(50)}>
              <div className="solution-demo-head">
                <h3>Interactive Mission Console</h3>
                <span className="solution-demo-tag">AI model + live map choreography</span>
              </div>
              <p>
                Use this during the pitch to walk judges through the actual workflow: the model detects an emergency vehicle at a camera,
                the system estimates time to the next signal, and the map shows how the corridor is pre-cleared before arrival.
              </p>

              <div className="solution-layout">
                <div className="solution-controls">
                  <div className="solution-toolbar-block">
                    <span className="solution-toolbar-label">Scenario</span>
                    <div className="solution-route-switcher">
                      {Object.entries(ROUTES).map(([routeKey, routeOption]) => (
                        <button
                          key={routeKey}
                          type="button"
                          className={`solution-switch-btn${selectedRoute === routeKey ? " active" : ""}`}
                          onClick={() => activateScenario(routeKey)}
                        >
                          {routeOption.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="solution-toolbar-block">
                    <span className="solution-toolbar-label">Story Presets</span>
                    <div className="solution-preset-grid">
                      {Object.entries(STORY_PRESETS).map(([presetKey, preset]) => (
                        <button
                          key={presetKey}
                          type="button"
                          className={`solution-switch-btn solution-preset-btn${activeStoryPreset === presetKey ? " active" : ""}`}
                          onClick={() => applyStoryPreset(presetKey)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="solution-toolbar-block">
                    <span className="solution-toolbar-label">Data Source</span>
                    <div className="solution-route-switcher">
                      <button
                        type="button"
                        className={`solution-switch-btn${demoModeEnabled ? " active" : ""}`}
                        onClick={toggleDemoMode}
                        disabled={demoModeSaving}
                      >
                        {demoModeSaving
                          ? "Switching..."
                          : demoModeEnabled
                            ? "Demo Mode ON"
                            : "Demo Mode OFF"}
                      </button>
                    </div>
                  </div>

                  <div className="solution-toolbar-block">
                    <span className="solution-toolbar-label">Map focus</span>
                    <div className="solution-focus-toolbar">
                      <button type="button" className={`solution-focus-btn${presentationFocus === "corridor" ? " active" : ""}`} onClick={() => setPresentationFocus("corridor")}>
                        Corridor
                      </button>
                      <button type="button" className={`solution-focus-btn${presentationFocus === "camera" ? " active" : ""}`} onClick={() => setPresentationFocus("camera")}>
                        Active Camera
                      </button>
                      <button type="button" className={`solution-focus-btn${presentationFocus === "signal" ? " active" : ""}`} onClick={() => setPresentationFocus("signal")}>
                        Next Signal
                      </button>
                      <button type="button" className={`solution-focus-btn${presentationFocus === "hospital" ? " active" : ""}`} onClick={() => setPresentationFocus("hospital")}>
                        Hospital
                      </button>
                    </div>
                  </div>

                  <div className="solution-metrics-grid">
                    <article>
                      <span>Corridor Progress</span>
                      <strong>{corridorProgress}%</strong>
                    </article>
                    <article>
                      <span>Emergency Feed</span>
                      <strong>
                        {liveVehicleUpdate
                          ? `${String(liveVehicleUpdate.vehicle || "Vehicle").toUpperCase()} • ETA ${upcomingEtaSeconds ?? "--"}s`
                          : "Waiting for live update"}
                      </strong>
                    </article>
                    <article>
                      <span>Active Camera</span>
                      <strong>{activeCameraNode ? activeCameraNode.id : "Scanning"}</strong>
                    </article>
                    <article>
                      <span>Priority Signal</span>
                      <strong>{upcomingIntersection ? `Intersection ${upcomingIntersection.id}` : "Completed"}</strong>
                    </article>
                    <article>
                      <span>Model Status</span>
                      <strong>{modelFeedLabel}</strong>
                    </article>
                  </div>
                </div>

                <aside className="solution-evidence-card">
                  <div className="solution-evidence-head">
                    <h4>AI Evidence Feed</h4>
                    <span>{modelFeedLabel}</span>
                  </div>
                  {webcamPredictedFrameUrl ? (
                    <img src={webcamPredictedFrameUrl} alt="Live AI evidence frame" className="solution-feed-frame" />
                  ) : videoPredictionUrl ? (
                    <video className="solution-feed-frame" src={videoPredictionUrl} controls playsInline preload="metadata" />
                  ) : (
                    <div className="solution-feed-placeholder">
                      <strong>No live model frame pinned yet</strong>
                      <span>{modelFeedHint}</span>
                    </div>
                  )}
                  <p>{modelFeedHint}</p>
                </aside>
              </div>

              <div className="solution-flow-grid" role="list" aria-label="Emergency corridor decision flow">
                {demoFlow.map((step, index) => {
                  let state = "waiting";
                  if (demoPhase > index) {
                    state = "done";
                  } else if (demoPhase === index) {
                    state = "current";
                  }

                  return (
                    <article key={step.title} className={`solution-step ${state}`} role="listitem">
                      <span className="solution-step-index">{index + 1}</span>
                      <h4>{step.title}</h4>
                      <p>{step.detail}</p>
                    </article>
                  );
                })}
              </div>

              <div className="solution-command-strip" aria-live="polite">
                <strong>Live command stream:</strong>
                <span>
                  {upcomingSignal
                    ? `${activeCameraNode ? `${activeCameraNode.id} DETECTED -> ` : "DETECTED -> "}ETA ${upcomingSignal.eta} -> NOTIFY SIGNAL ${upcomingSignal.intersection} -> SWITCH GREEN`
                    : "CORRIDOR COMPLETE -> VEHICLE REACHED DESTINATION"}
                </span>
              </div>

              <div className="solution-actions-row">
                <button type="button" className="action-btn" onClick={replayScenario}>Replay Scenario</button>
                <button type="button" className="action-btn secondary" onClick={() => setIsRunning((prev) => !prev)}>
                  {isRunning ? "Pause Simulation" : "Resume Simulation"}
                </button>
              </div>
            </section>

            <div className="dashboard primary-grid">
              <section className="panel emergency-vehicle-panel reveal" data-reveal style={revealDelay(120)}>
                <h2>Emergency Vehicle Monitoring</h2>
                <ul className="kv-list">
                  <li>
                    <span>Emergency Vehicle ID</span>
                    <strong>A102</strong>
                  </li>
                  <li>
                    <span>Current Speed</span>
                    <strong>{speedKmh} km/h</strong>
                  </li>
                  <li>
                    <span>Current Location</span>
                    <strong>{currentCoord[0].toFixed(4)}, {currentCoord[1].toFixed(4)}</strong>
                  </li>
                  <li>
                    <span>Destination</span>
                    <strong>{HOSPITAL.name}</strong>
                  </li>
                  <li>
                    <span>Estimated ETA</span>
                    <strong>{emergencyVehicleEtaMinutes} minutes</strong>
                  </li>
                </ul>
              </section>

              <section className="panel signal-panel reveal" data-reveal style={revealDelay(170)}>
                <h2>Automatic Traffic Signal Control</h2>
                <div className="signal-live-eta-wrap">
                  <LiveEtaCountdown etaSeconds={upcomingEtaSeconds} />
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Intersection</th>
                      <th>Signal</th>
                      <th>ETA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displaySignalRows.map((row) => (
                      <tr key={row.intersection}>
                        <td>{row.intersection}</td>
                        <td>
                          <span className={`signal-dot ${row.signal.toLowerCase()}`} aria-hidden="true" />
                          <span className={`pill ${row.signal.toLowerCase()}`}>{row.signal}</span>
                        </td>
                        <td>{row.eta}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="panel alert-panel reveal" data-reveal style={revealDelay(220)}>
                <h2>Emergency Alert System</h2>
                {alerts.map((alert, index) => (
                  <div className="alert" key={`${alert}-${index}`}>
                    {alert}
                  </div>
                ))}
              </section>
            </div>
          </div>
        </section>

        <section className="container reveal is-visible" data-reveal style={revealDelay(30)}>
          <div className="hero-visual-card">
            <div className="green-corridor-3d" aria-hidden="true">
              {/* Night-sky environment */}
              <div className="gc-night-sky" />
              <div className="gc-city-bg" />
              <div className="gc-horizon-haze" />
              <div className="gc-stars" />

              {/* Branding */}
              <div className="gc-title-wrap">
                <div className="gc-title-block">
                  <span className="gc-title-main">GREEN</span>
                  <span className="gc-title-sub">CORRIDOR</span>
                  <span className="gc-title-caption">SMART TRAFFIC | EMERGENCY RESPONSE</span>
                </div>
                <div className="gc-live-pill">
                  <span className="gc-live-dot" />
                  <span className="gc-live-label">LIVE</span>
                </div>
              </div>

              {/* 3D Road scene */}
              <div className="gc-road-scene">
                {/* Asphalt road with perspective */}
                <div className="gc-road-asphalt">
                  <div className="gc-road-sheen" />
                  <div className="gc-curb gc-curb-top" />
                  <div className="gc-curb gc-curb-bot" />
                  <span className="gc-lm gc-lm-1" />
                  <span className="gc-lm gc-lm-2" />
                  <span className="gc-lm gc-lm-3" />
                  <span className="gc-lm gc-lm-4" />
                  <span className="gc-lm gc-lm-5" />
                  <div className="gc-road-centerline" />
                </div>

                {/* Traffic signal with pole */}
                <div className="gc-sig-post">
                  <div className="gc-sig-pole" />
                  <div className="gc-sig-head">
                    <span className="gc-sig-lens l-red" />
                    <span className="gc-sig-lens l-amber" />
                    <span className="gc-sig-lens l-green" />
                  </div>
                  <div className="gc-sig-glow-spill" />
                </div>

                {/* Detailed emergency vehicle */}
                <div className="gc-emergency-vehicle">
                  {/* Roof lightbar assembly */}
                  <div className="gc-v-lightbar">
                    <span className="gc-lb lb-r1" />
                    <span className="gc-lb lb-b" />
                    <span className="gc-lb lb-r2" />
                  </div>
                  {/* Beacon colour cast on road */}
                  <div className="gc-v-beacon-cast" />
                  {/* Body: cab + box */}
                  <div className="gc-v-body">
                    <div className="gc-v-cab">
                      <span className="gc-v-screen" />
                      <span className="gc-v-mirror" />
                      <span className="gc-v-hl" />
                      <span className="gc-v-bumper" />
                    </div>
                    <div className="gc-v-box">
                      <span className="gc-v-stripe" />
                      <span className="gc-v-sidewin" />
                      <span className="gc-v-cross">+</span>
                      <span className="gc-v-door-line" />
                      <span className="gc-v-rear-light" />
                    </div>
                  </div>
                  {/* Undercarriage */}
                  <div className="gc-v-floor" />
                  {/* Wheels */}
                  <span className="gc-v-wheel wh-f" />
                  <span className="gc-v-wheel wh-r" />
                  {/* Ground shadow */}
                  <div className="gc-v-shadow" />
                  {/* Headlight beam */}
                  <div className="gc-v-headbeam" />
                </div>
              </div>
            </div>
            <div className="hero-visual-copy">
              <h2>Live Operational Snapshot</h2>
              <p>
                This dashboard is actively coordinating emergency priority through route tracking, camera intelligence, and adaptive
                signal control. Current corridor status updates in real time as field conditions change.
              </p>
              <div className="hero-metrics" role="list" aria-label="Live product metrics">
                <article className="hero-metric" role="listitem">
                  <span>Current Speed</span>
                  <strong>{speedKmh} km/h</strong>
                </article>
                <article className="hero-metric" role="listitem">
                  <span>Active AI Detections</span>
                  <strong>{detectedCameraCount}/3 cameras</strong>
                </article>
                <article className="hero-metric" role="listitem">
                  <span>Estimated Arrival</span>
                  <strong>{emergencyVehicleEtaMinutes} min</strong>
                </article>
                <article className="hero-metric" role="listitem">
                  <span>Signal Priority Window</span>
                  <strong>{nextSignalLabel} • {greenSignalCount}/{displaySignalRows.length} green</strong>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className="scroll-section" id="detection-intelligence-section">
          <div className="container section-block">
            <div className="section-head reveal" data-reveal style={revealDelay(80)}>
              <p className="section-kicker">Section 02</p>
              <h2>Detection and Decision Intelligence</h2>
              <p className="section-subtitle">AI camera detection feeds, intelligent logs, and traffic density intelligence.</p>
            </div>

            <div className="dashboard ops-grid">
              <section className="panel camera-panel reveal" data-reveal style={revealDelay(260)}>
                <h2>AI Emergency Vehicle Detection from Cameras</h2>
                <div className="ai-feature-grid">
                  <article className="camera-card live-card">
                    <h3>Live Webcam Detection</h3>
                    <p>Run real-time emergency vehicle detection from your webcam feed.</p>
                    <div className="camera-actions">
                      <button type="button" className="action-btn" onClick={startWebcamInference} disabled={webcamRunning || webcamConnecting}>
                        {webcamConnecting ? "Connecting..." : "Start Webcam AI"}
                      </button>
                      <button type="button" className="action-btn secondary" onClick={stopWebcamInference} disabled={!webcamRunning && !webcamConnecting}>
                        Stop
                      </button>
                    </div>
                    {webcamError ? <p className="camera-error">{webcamError}</p> : null}

                    <div className="live-preview-grid">
                      <div>
                        <small className="preview-label">Camera Input</small>
                        <video ref={webcamVideoRef} className="video-preview" autoPlay muted playsInline />
                      </div>
                      <div>
                        <small className="preview-label">AI Prediction Output</small>
                        {webcamPredictedFrameUrl ? (
                          <img src={webcamPredictedFrameUrl} alt="Predicted webcam frame" className="video-preview" />
                        ) : (
                          <div className="camera-feed placeholder-feed">Prediction frame will appear here</div>
                        )}
                      </div>
                    </div>
                    <canvas ref={webcamCanvasRef} className="hidden-canvas" />
                  </article>

                  <article className="camera-card upload-card">
                    <div className="upload-card-head">
                      <div>
                        <h3>Upload Video for Judges</h3>
                        <p>Submit recorded evidence and generate an AI-annotated review clip.</p>
                      </div>
                      <span className="upload-status-badge">Evidence Review</span>
                    </div>

                    <div className="upload-dropzone">
                      <label htmlFor="judge-video-upload" className="upload-file-label">
                        <span className="upload-file-title">Select Video</span>
                        <span className="upload-file-subtitle">MP4, MOV, AVI, MKV supported</span>
                      </label>
                      <input id="judge-video-upload" type="file" accept="video/*" onChange={onVideoFileSelect} className="upload-file-input" />
                      <p className="upload-file-meta">
                        {videoUploadFile ? `${videoUploadFile.name} • ${formatFileSize(videoUploadFile.size)}` : "No file selected yet"}
                      </p>
                    </div>

                    <div className="camera-actions upload-actions">
                      <button type="button" className="action-btn" onClick={runVideoPrediction} disabled={!videoUploadFile || videoPredicting}>
                        {videoPredicting ? "Processing Video..." : "Run AI Analysis"}
                      </button>
                    </div>
                    {videoPredictError ? <p className="camera-error">{videoPredictError}</p> : null}

                    <div className="upload-preview-grid">
                      <div className="preview-pane">
                        <small className="preview-label">Original Upload</small>
                        {videoUploadPreviewUrl ? (
                          <video className="video-preview" src={videoUploadPreviewUrl} controls />
                        ) : (
                          <div className="camera-feed placeholder-feed">Select a video file to preview</div>
                        )}
                      </div>
                      <div className="preview-pane">
                        <small className="preview-label">AI Annotated Output</small>
                        {videoPredictionUrl ? (
                          <video ref={outputVideoElementRef} className="video-preview" src={videoPredictionUrl} controls playsInline preload="metadata" />
                        ) : (
                          <div className="camera-feed placeholder-feed">Predicted output video will appear here</div>
                        )}
                      </div>
                    </div>
                  </article>
                </div>
              </section>

              <section className="panel logs-panel reveal" data-reveal style={revealDelay(310)}>
                <h2>Intelligent Decision Logs</h2>
                <ul className="logs-list">
                  {logs.map((entry, index) => (
                    <li key={`${entry.time}-${index}`}>
                      <code>{entry.time}</code>
                      <span>{entry.text}</span>
                    </li>
                  ))}
                </ul>
              </section>

            </div>
          </div>
        </section>

        <section className="scroll-section" id="impact-analytics-section">
          <div className="container section-block">
            <div className="section-head reveal" data-reveal style={revealDelay(100)}>
              <p className="section-kicker">Section 03</p>
              <h2>System Impact Analytics</h2>
              <p className="section-subtitle">Performance outcomes showing emergency response and coordination improvements.</p>
            </div>

            <div className="dashboard analytics-only-grid">
              <section className="panel analytics-panel reveal" data-reveal style={revealDelay(460)}>
                <h2>System Analytics</h2>
                <div className="analytics-grid">
                  <article>
                    <h3>{analytics.delayReduced}</h3>
                    <p>Average delay reduced</p>
                  </article>
                  <article>
                    <h3>{analytics.coordinatedSignals}</h3>
                    <p>Signals coordinated</p>
                  </article>
                  <article>
                    <h3>{analytics.responseSaved}</h3>
                    <p>Response time saved</p>
                  </article>
                </div>
              </section>
            </div>
          </div>
        </section>
      </main>

      {navOpen && (
        <div className="nav-overlay" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className={`nav-topbar${navNavigating ? " navigating" : ""}`}>
            <button
              type="button"
              className="nav-back-btn"
              onClick={() => {
                if (navNavigating) {
                  setNavNavigating(false);
                  return;
                }

                setNavOpen(false);
                setNavSearchQuery("");
                setNavSearchResults([]);
              }}
            >
              {navNavigating ? "← Overview" : "← Back"}
            </button>
            {navNavigating ? (
              <div className="nav-guidance-card">
                <span className="nav-guidance-icon" aria-hidden="true">
                  {getStepGlyph(navPrimaryStep)}
                </span>
                <div className="nav-guidance-copy">
                  <strong>{getStepInstruction(navPrimaryStep)}</strong>
                  <span>
                    {navPrimaryStep
                      ? `${formatDistance(navPrimaryStep.distance || 0)} to next step`
                      : `${formatDistance(navRoute?.distance || 0)} remaining`}
                  </span>
                </div>
              </div>
            ) : (
              <div className="nav-search-wrap">
                <div className="nav-search-shell">
                  <span className="nav-search-leading" aria-hidden="true">
                    ⌕
                  </span>
                  <input
                    className="nav-search-input"
                    type="search"
                    placeholder="Search hospitals, roads, landmarks"
                    value={navSearchQuery}
                    onChange={(e) => setNavSearchQuery(e.target.value)}
                    autoFocus
                  />
                  <div className="nav-search-actions">
                    {navSearchLoading && <span className="nav-search-spinner">Searching…</span>}
                    {navSearchQuery && (
                      <button
                        type="button"
                        className="nav-ghost-icon-btn nav-clear-btn"
                        onClick={() => {
                          setNavSearchQuery("");
                          setNavSearchResults([]);
                        }}
                        aria-label="Clear search"
                      >
                        ×
                      </button>
                    )}
                    <button
                      type="button"
                      className="nav-ghost-icon-btn nav-gps-btn"
                      onClick={requestCurrentLocation}
                      aria-label="Use current GPS location"
                      title="Use current GPS location"
                    >
                      {navGpsLoading ? "..." : "◎"}
                    </button>
                    <button
                      type="button"
                      className="nav-ghost-icon-btn nav-tab-toggle-btn"
                      onClick={() => setNavSideTabOpen((prev) => !prev)}
                      aria-label={navSideTabOpen ? "Hide nearby hospitals tab" : "Show nearby hospitals tab"}
                      title={navSideTabOpen ? "Hide nearby hospitals tab" : "Show nearby hospitals tab"}
                    >
                      {navSideTabOpen ? "▤" : "▥"}
                    </button>
                  </div>
                </div>

              </div>
            )}
          </div>

          <div className="nav-status-rail" aria-label="Navigation status">
            <article className="nav-status-card">
              <span>Mode</span>
              <strong>{navNavigating ? "Turn-by-turn" : "Planning"}</strong>
            </article>
            <article className="nav-status-card">
              <span>Start</span>
              <strong>{navUserLocation ? "GPS Locked" : "Emergency Vehicle"}</strong>
            </article>
            <article className="nav-status-card nav-status-card-wide">
              <span>Destination</span>
              <strong>{navDestination ? navDestination.name.split(",")[0] : "Select on map"}</strong>
            </article>
            <article className="nav-status-card">
              <span>Route</span>
              <strong>{navRoute ? `${(navRoute.distance / 1000).toFixed(1)} km` : "--"}</strong>
            </article>
          </div>

          <div className="nav-map-area" ref={navMapElementRef} />

          {!navNavigating && navSideTabOpen &&
          ((!navSearchQuery.trim() && (navNearbyHospitals.length > 0 || navNearbyHospitalsLoading)) ||
            (navSearchResults.length > 0 || (!!navSearchQuery.trim() && !navSearchLoading) || navGpsError)) ? (
            <aside className="nav-side-tab" role="listbox" aria-label="Search suggestions">
              {(!navSearchQuery.trim() && (navNearbyHospitals.length > 0 || navNearbyHospitalsLoading)) ? (
                <div className="nav-search-results">
                  <p className="nav-nearby-label">
                    {navNearbyHospitalsLoading ? "Finding nearby hospitals…" : "Nearby Hospitals"}
                  </p>
                  {!navNearbyHospitalsLoading && (
                    <ul className="nav-search-results-list">
                      {navNearbyHospitals.map((h) => (
                        <li
                          key={h.place_id}
                          role="option"
                          onClick={() => {
                            setNavDestination({
                              name: h.display_name,
                              coord: [parseFloat(h.lat), parseFloat(h.lon)],
                            });
                            setNavSearchQuery(h.display_name);
                            setNavSearchResults([]);
                            if (navMapRef.current) {
                              navMapRef.current.flyTo([parseFloat(h.lat), parseFloat(h.lon)], 15, { duration: 1 });
                            }
                          }}
                        >
                          <span className="nav-result-badge" aria-hidden="true">🏥</span>
                          <span className="nav-result-copy">
                            <span className="nav-result-name">{h.name || h.display_name.split(",")[0]}</span>
                            <span className="nav-result-addr">{h.display_name}</span>
                            <span className="nav-result-meta">Tap to get directions</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {navGpsError ? <p className="nav-gps-note">{navGpsError}</p> : null}
                </div>
              ) : (
                <div className="nav-search-results">
                  {navSearchResults.length > 0 ? (
                    <ul className="nav-search-results-list">
                      {navSearchResults.map((result) => (
                        <li
                          key={result.place_id}
                          role="option"
                          onClick={() => {
                            setNavDestination({
                              name: result.display_name,
                              coord: [parseFloat(result.lat), parseFloat(result.lon)],
                            });
                            setNavSearchQuery(result.display_name);
                            setNavSearchResults([]);

                            if (navMapRef.current) {
                              navMapRef.current.flyTo([parseFloat(result.lat), parseFloat(result.lon)], 15, {
                                duration: 1,
                              });
                            }
                          }}
                        >
                          <span className="nav-result-badge" aria-hidden="true">
                            •
                          </span>
                          <span className="nav-result-copy">
                            <span className="nav-result-name">{result.name || result.display_name.split(",")[0]}</span>
                            <span className="nav-result-addr">{result.display_name}</span>
                            <span className="nav-result-meta">Tap to set destination and build route</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="nav-search-empty">
                      <strong>No matching places found.</strong>
                      <span>Try a landmark, hospital, neighborhood, or tap directly on the map.</span>
                    </div>
                  )}
                  {navGpsError ? <p className="nav-gps-note">{navGpsError}</p> : null}
                </div>
              )}
            </aside>
          ) : null}

          <button
            type="button"
            className="nav-fab nav-locate-btn"
            onClick={requestCurrentLocation}
            aria-label="Locate me"
            title="Locate me"
          >
            {navGpsLoading ? "..." : "◎"}
          </button>

          <div className={`nav-bottombar${navNavigating ? " navigating" : ""}`}>
            {navRoute ? navNavigating ? (
              <>
                <div className="nav-drive-summary">
                  <span className="nav-drive-eta">{formatDuration(navRoute.duration)}</span>
                  <div className="nav-drive-copy">
                    <strong>{navDestination ? navDestination.name.split(",")[0] : "Destination set"}</strong>
                    <span>{formatDistance(navRoute.distance)} remaining on route</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="nav-end-btn"
                  onClick={() => setNavNavigating(false)}
                >
                  End Navigation View
                </button>
              </>
            ) : (
              <>
                <div className="nav-route-info">
                  <span className="nav-stat">
                    <strong>{(navRoute.distance / 1000).toFixed(1)}</strong> km
                  </span>
                  <span className="nav-stat">
                    <strong>{Math.round(navRoute.duration / 60)}</strong> min
                  </span>
                  <span className="nav-stat nav-source-chip">{navUserLocation ? "GPS Start" : "Emergency Vehicle Start"}</span>
                  {navDestination && (
                    <span className="nav-dest-name">→ {navDestination.name.split(",")[0]}</span>
                  )}
                </div>
                <button
                  type="button"
                  className={`nav-start-btn${navNavigating ? " navigating" : ""}`}
                  onClick={() => {
                    setNavNavigating(true);
                    setNavSearchResults([]);
                  }}
                >
                  {navNavigating ? "● Navigating…" : "Start Navigation →"}
                </button>
              </>
            ) : (
              <p className="nav-hint">
                {navDestination
                  ? "Fetching route…"
                  : "Search above, tap the GPS button, or click anywhere on the map to choose a destination"}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default App;
