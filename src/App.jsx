import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";

const HOSPITAL = {
  name: "City Hospital",
  coord: [28.6224, 77.2198],
};

const ROUTES = {
  alpha: {
    name: "Route Alpha",
    points: [
      [28.6139, 77.209],
      [28.6152, 77.2115],
      [28.6167, 77.2142],
      [28.6183, 77.2168],
      [28.62, 77.2182],
      [28.6214, 77.219],
      [28.6224, 77.2198],
    ],
    intersections: [
      { id: "A", pointIndex: 1, coord: [28.6152, 77.2115] },
      { id: "B", pointIndex: 3, coord: [28.6183, 77.2168] },
      { id: "C", pointIndex: 5, coord: [28.6214, 77.219] },
    ],
  },
  beta: {
    name: "Route Beta",
    points: [
      [28.6112, 77.2068],
      [28.6129, 77.2105],
      [28.6148, 77.2137],
      [28.6164, 77.216],
      [28.6187, 77.2177],
      [28.6209, 77.2188],
      [28.6224, 77.2198],
    ],
    intersections: [
      { id: "A", pointIndex: 1, coord: [28.6129, 77.2105] },
      { id: "B", pointIndex: 2, coord: [28.6148, 77.2137] },
      { id: "D", pointIndex: 4, coord: [28.6187, 77.2177] },
    ],
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

function App() {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);
  const navMapElementRef = useRef(null);
  const navMapRef = useRef(null);
  const navBaseLayerRef = useRef(null);
  const navRouteLayerRef = useRef(null);
  const navSearchTimerRef = useRef(null);
  const navInitRef = useRef(false);
  const navStartCoordRef = useRef(null);
  const [theme, setTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem("traffic-dashboard-theme");
    return savedTheme === "dark" ? "dark" : "light";
  });

  const [selectedRoute, setSelectedRoute] = useState("alpha");
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

  const route = ROUTES[selectedRoute];
  const currentCoord = route.points[emergencyVehicleIndex];

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

  const nearestNextSignal = useMemo(() => {
    const next = signalRows.find((row) => row.etaSeconds > 0);
    return next ? next.intersection : null;
  }, [signalRows]);

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

  const analytics = useMemo(() => {
    const greenCount = signalRows.filter((row) => row.signal === "Green").length;
    return {
      delayReduced: "32%",
      coordinatedSignals: `${greenCount}/${signalRows.length}`,
      responseSaved: "2.5 minutes",
    };
  }, [signalRows]);

  const emergencyVehicleEtaMinutes = Math.max((route.points.length - 1 - emergencyVehicleIndex) * 0.55, 0.5).toFixed(1);
  const navPrimaryStep = useMemo(() => {
    if (!navRoute?.steps?.length) {
      return null;
    }

    return navRoute.steps.find((step) => step.maneuver?.type !== "depart") || navRoute.steps[0];
  }, [navRoute]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("traffic-dashboard-theme", theme);
  }, [theme]);

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

    route.intersections.forEach((intersection) => {
      const row = signalRows.find((item) => item.intersection === intersection.id);
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

    L.circleMarker(HOSPITAL.coord, {
      radius: 10,
      color: "#0f2238",
      fillColor: "#ffd43b",
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(HOSPITAL.name)
      .addTo(group);

    L.circleMarker(currentCoord, {
      radius: 11,
      color: "#ffffff",
      fillColor: "#ef4444",
      fillOpacity: 1,
      weight: 3,
    })
      .bindTooltip("Emergency Vehile", { direction: "top" })
      .addTo(group);

    mapRef.current.panTo(currentCoord, { animate: true, duration: 0.8 });
  }, [currentCoord, route, signalRows]);

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
          setLogs((prev) => [{ time: nowTime(), text: "Emergency Vehile reached destination" }, ...prev].slice(0, 10));
          setAlerts(["Emergency Vehile reached City Hospital", "Route completed successfully"]);
          return current;
        }

        const passedIntersection = route.intersections.find((item) => item.pointIndex === next);
        if (passedIntersection) {
          setLogs((prev) =>
            [
              { time: nowTime(), text: `Emergency Vehile passed intersection ${passedIntersection.id}` },
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
      return;
    }
    const tid = setTimeout(() => {
      const el = navMapElementRef.current;
      if (!el || navInitRef.current) return;
      navInitRef.current = true;
      const startCoord = navStartCoordRef.current || [28.6139, 77.209];
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

    const startCoord = navUserLocation?.coord || navStartCoordRef.current || [28.6139, 77.209];

    L.circleMarker(startCoord, {
      radius: 12,
      color: "#ffffff",
      fillColor: navUserLocation ? "#0e7be6" : "#ef4444",
      fillOpacity: 1,
      weight: 3,
    })
      .bindTooltip(navUserLocation ? "Current GPS Location" : "Emergency Vehile (Start)", {
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

  // Nav search (Nominatim)
  useEffect(() => {
    clearTimeout(navSearchTimerRef.current);
    if (!navSearchQuery.trim()) {
      setNavSearchResults([]);
      return;
    }
    const tid = setTimeout(async () => {
      setNavSearchLoading(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(navSearchQuery)}&format=json&limit=6`,
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
  }, [navSearchQuery]);

  // Fetch route via OSRM when destination is set
  useEffect(() => {
    if (!navDestination) return;
    const start = navUserLocation?.coord || navStartCoordRef.current || [28.6139, 77.209];
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

  const trafficDensity = BASE_TRAFFIC.map((item) => {
    const variance = ((emergencyVehicleIndex + item.id.charCodeAt(0)) % 5) - 2;
    const vehicles = Math.max(item.vehicles + variance, 3);
    const traffic = vehicles > 28 ? "High" : vehicles > 15 ? "Moderate" : "Low";
    return { ...item, vehicles, traffic };
  });

  const revealDelay = (ms) => ({ "--reveal-delay": `${ms}ms` });

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

  return (
    <>
      <div className="ambient-bg" aria-hidden="true" />
      <header className="header container reveal is-visible" data-reveal style={revealDelay(0)}>
        <div>
          <p className="eyebrow">City Emergency Coordination Dashboard</p>
          <h1 className="brand-title">
            <span className="brand-main">Green Corridor</span>
            <span className="brand-sub">Live Emergency Vehile Priority Management</span>
          </h1>
          <p className="subtitle">
            Real-time tracking, automatic signal control, camera AI detection, and decision intelligence for emergency corridors.
          </p>
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? "Enable Dark Mode" : "Enable Light Mode"}
          </button>
          <div className="status-chip">Backend: Connected</div>
        </div>
      </header>

      <section className="container reveal is-visible" data-reveal style={revealDelay(30)}>
        <div className="hero-visual-card">
          <div className="green-corridor-3d" aria-hidden="true">
            <div className="gc-title-wrap">
              <h3 className="gc-title-main">GREEN</h3>
              <h3 className="gc-title-sub">CORRIDOR</h3>
              <p className="gc-title-caption">SMART TRAFFIC | EMERGENCY RESPONSE</p>
            </div>

            <div className="gc-road-platform">
              <div className="gc-road-lane" />
              <div className="gc-road-lane lane-2" />
              <div className="gc-road-lane lane-3" />
              <div className="gc-road-lane lane-4" />

              <div className="gc-emergency-vehicle">
                <span className="gc-ambu-light" />
                <span className="gc-ambu-wheel wheel-left" />
                <span className="gc-ambu-wheel wheel-right" />
              </div>

              <div className="gc-signal">
                <span className="signal red" />
                <span className="signal amber" />
                <span className="signal green" />
              </div>
            </div>
          </div>
          <div className="hero-visual-copy">
            <h2>3D Coordination Core</h2>
            <p>
              Green Corridor visualization for your demo: animated emergency vehile movement, pre-coordinated lane corridor, and
              responsive traffic signal priority in a 3D presentation style.
            </p>
          </div>
        </div>
      </section>

      <main className="page-sections">
        <section className="scroll-section">
          <div className="container section-block">
            <div className="section-head reveal" data-reveal style={revealDelay(40)}>
              <p className="section-kicker">Section 01</p>
              <h2>Live Green Corridor</h2>
              <p className="section-subtitle">Real-time emergency route tracking, signal adaptation, and live emergency vehile status.</p>
            </div>

            <div className="dashboard primary-grid">
              <section className="panel map-panel reveal" data-reveal style={revealDelay(60)}>
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
                  Emergency vehile position, route path, intersection signal states, and hospital destination are updated continuously.
                </div>
              </section>

              <section className="panel emergency-vehicle-panel reveal" data-reveal style={revealDelay(120)}>
                <h2>Emergency Vehile Monitoring</h2>
                <ul className="kv-list">
                  <li>
                    <span>Emergency Vehile ID</span>
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
                <table>
                  <thead>
                    <tr>
                      <th>Intersection</th>
                      <th>Signal</th>
                      <th>ETA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signalRows.map((row) => (
                      <tr key={row.intersection}>
                        <td>{row.intersection}</td>
                        <td>
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

        <section className="scroll-section">
          <div className="container section-block">
            <div className="section-head reveal" data-reveal style={revealDelay(80)}>
              <p className="section-kicker">Section 02</p>
              <h2>Detection and Decision Intelligence</h2>
              <p className="section-subtitle">AI camera detection feeds, intelligent logs, and traffic density intelligence.</p>
            </div>

            <div className="dashboard ops-grid">
              <section className="panel camera-panel reveal" data-reveal style={revealDelay(260)}>
                <h2>AI Emergency Vehile Detection from Cameras</h2>
                <div className="camera-grid">
                  {cameras.map((camera) => (
                    <article className="camera-card" key={camera.id}>
                      <div className="camera-feed">
                        {camera.detected ? <div className="bbox" /> : null}
                      </div>
                      <h3>{camera.id}</h3>
                      <p>{camera.detected ? "Emergency Vehile detected" : "No emergency vehile"}</p>
                      <small>Confidence: {camera.detected ? `${camera.confidence}%` : "0%"}</small>
                    </article>
                  ))}
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

              <section className="panel density-panel reveal" data-reveal style={revealDelay(360)}>
                <h2>Traffic Density Monitoring</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Intersection</th>
                      <th>Vehicles</th>
                      <th>Traffic</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trafficDensity.map((item) => (
                      <tr key={item.id}>
                        <td>{item.id}</td>
                        <td>{item.vehicles}</td>
                        <td>{item.traffic}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        </section>

        <section className="scroll-section">
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
                  </div>
                </div>

                {(navSearchResults.length > 0 || (!!navSearchQuery.trim() && !navSearchLoading) || navGpsError) && (
                  <div className="nav-search-results" role="listbox">
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
              </div>
            )}
          </div>

          <div className="nav-map-area" ref={navMapElementRef} />

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
                  <span className="nav-stat nav-source-chip">{navUserLocation ? "GPS Start" : "Emergency Vehile Start"}</span>
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
