import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import nipplejs from 'nipplejs';
import * as turf from '@turf/turf';
import { supabase } from './lib/supabase';
import './App.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const DEFAULT_LAT = 34.4825;
const DEFAULT_LNG = 132.5180;
const DEFAULT_BOUNDS = {
  minLat: 34.4700,
  maxLat: 34.4950,
  minLng: 132.5000,
  maxLng: 132.5350
};

const SHELTERS = [
  { name: '深川小学校（指定避難所）', lat: 34.4830, lng: 132.5190 },
  { name: '安佐北区スポーツセンター', lat: 34.4865, lng: 132.5145 },
  { name: '可部南小学校', lat: 34.4910, lng: 132.5110 }
];

export default function App() {
  const mapRef = useRef(null);
  const joystickRef = useRef(null);
  const leafletMap = useRef(null);
  const playerMarker = useRef(null);
  const configMarkerRef = useRef(null);
  const polylineRef = useRef(null);
  const boundsLayerRef = useRef(null);
  const dashboardPolylines = useRef([]);

  const [isRecording, setIsRecording] = useState(false);
  const [roadStatus, setRoadStatus] = useState('準備中');

  // 設定用
  const [showSettings, setShowSettings] = useState(false);
  const [settingsAuth, setSettingsAuth] = useState(false);
  const [settingsPass, setSettingsPass] = useState('');
  const [initLat, setInitLat] = useState(DEFAULT_LAT);
  const [initLng, setInitLng] = useState(DEFAULT_LNG);
  const [bounds, setBounds] = useState(DEFAULT_BOUNDS);

  // ダッシュボード用
  const [showDashboard, setShowDashboard] = useState(false);
  const [dashboardAuth, setDashboardAuth] = useState(false);
  const [dashboardPass, setDashboardPass] = useState('');
  const [routesList, setRoutesList] = useState([]);

  const currentPos = useRef([DEFAULT_LAT, DEFAULT_LNG]);
  const pathCoordinates = useRef([]);
  const roadFeatures = useRef([]);
  const moveVector = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!mapRef.current || !joystickRef.current) return;

    const map = L.map(mapRef.current, {
      dragging: true,
      zoomControl: true,
      doubleClickZoom: true
    }).setView(currentPos.current, 16);

    leafletMap.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    const shelterIcon = L.icon({
      iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
      shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowSize: [41, 41]
    });

    SHELTERS.forEach(shelter => {
      L.marker([shelter.lat, shelter.lng], { icon: shelterIcon })
        .addTo(map)
        .bindPopup(`<b>避難所</b><br>${shelter.name}`);
    });

    const playerIcon = L.divIcon({ className: 'player-icon', iconSize: [18, 18], iconAnchor: [9, 9] });
    playerMarker.current = L.marker(currentPos.current, { icon: playerIcon }).addTo(map);
    polylineRef.current = L.polyline([], { color: '#0066ff', weight: 6, opacity: 0.8 }).addTo(map);

    // Supabaseから保存された設定をロードする
    loadSettingsFromSupabase();

    const manager = nipplejs.create({
      zone: joystickRef.current,
      mode: 'static',
      position: { left: '60px', bottom: '60px' },
      color: 'black',
      size: 100
    });

    manager.on('move', (evt, data) => {
      if (data && data.vector) moveVector.current = { x: data.vector.x, y: data.vector.y };
    });
    manager.on('end', () => { moveVector.current = { x: 0, y: 0 }; });

    const keysPressed = {};
    const handleKeyDown = (e) => { keysPressed[e.key.toLowerCase()] = true; updateKeyVector(); };
    const handleKeyUp = (e) => { keysPressed[e.key.toLowerCase()] = false; updateKeyVector(); };

    function updateKeyVector() {
      let x = 0, y = 0;
      if (keysPressed['w'] || keysPressed['arrowup']) y += 1;
      if (keysPressed['s'] || keysPressed['arrowdown']) y -= 1;
      if (keysPressed['a'] || keysPressed['arrowleft']) x -= 1;
      if (keysPressed['d'] || keysPressed['arrowright']) x += 1;
      if (x !== 0 && y !== 0) { x *= 0.7071; y *= 0.7071; }
      moveVector.current = { x, y };
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    let animationFrameId;
    let lastRecordTime = 0;
    const SPEED = 0.00003;

    function gameLoop(timestamp) {
      if (moveVector.current.x !== 0 || moveVector.current.y !== 0) {
        let targetLat = currentPos.current[0] + (moveVector.current.y * SPEED);
        let targetLng = currentPos.current[1] + (moveVector.current.x * SPEED);

        targetLat = Math.max(bounds.minLat, Math.min(bounds.maxLat, targetLat));
        targetLng = Math.max(bounds.minLng, Math.min(bounds.maxLng, targetLng));

        let nextPos = [targetLat, targetLng];

        if (roadFeatures.current.length > 0) {
          const targetPt = turf.point([targetLng, targetLat]);
          let closestSnap = null;
          let minDistance = Infinity;

          for (let i = 0; i < roadFeatures.current.length; i++) {
            const snapped = turf.nearestPointOnLine(roadFeatures.current[i], targetPt);
            if (snapped.properties.dist < minDistance) {
              minDistance = snapped.properties.dist;
              closestSnap = snapped;
            }
          }

          if (closestSnap && minDistance <= 0.015) {
            nextPos = [closestSnap.geometry.coordinates[1], closestSnap.geometry.coordinates[0]];
          }
        }

        currentPos.current = nextPos;
        map.panTo(currentPos.current, { animate: false });
        playerMarker.current.setLatLng(currentPos.current);

        if (polylineRef.current.isRecording && timestamp - lastRecordTime > 120) {
          pathCoordinates.current.push(currentPos.current);
          polylineRef.current.setLatLngs(pathCoordinates.current);
          lastRecordTime = timestamp;
        }
      }
      animationFrameId = requestAnimationFrame(gameLoop);
    }

    animationFrameId = requestAnimationFrame(gameLoop);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      cancelAnimationFrame(animationFrameId);
      manager.destroy();
      map.remove();
    };
  }, []);

  // Supabaseからの設定ロード
  const loadSettingsFromSupabase = async () => {
    const { data, error } = await supabase
      .from('system_settings')
      .select('*')
      .eq('id', 'default_config')
      .single();

    if (!error && data) {
      const lat = parseFloat(data.init_lat);
      const lng = parseFloat(data.init_lng);
      setInitLat(lat);
      setInitLng(lng);
      setBounds(data.bounds);

      currentPos.current = [lat, lng];
      if (leafletMap.current) {
        leafletMap.current.setView([lat, lng], 16);
        playerMarker.current.setLatLng([lat, lng]);
        updateBoundsLayer(data.bounds);
        fetchRoadsWithRetry(data.bounds);
      }
    } else {
      updateBoundsLayer(bounds);
      fetchRoadsWithRetry(bounds);
    }
  };

  const updateBoundsLayer = (b) => {
    if (!leafletMap.current) return;
    if (boundsLayerRef.current) leafletMap.current.removeLayer(boundsLayerRef.current);
    boundsLayerRef.current = L.rectangle([
      [b.minLat, b.minLng],
      [b.maxLat, b.maxLng]
    ], { color: 'red', weight: 2, fill: false, dashArray: '5, 10' }).addTo(leafletMap.current);
  };

  const fetchRoadsWithRetry = async (b) => {
    setRoadStatus('取得中...');
    const bbox = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
    const query = `[out:json][timeout:15];way["highway"](${bbox});out geom;`;

    const endpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://api.openstreetmap.fr/oapi/interpreter'
    ];

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`);
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.elements) {
          roadFeatures.current = data.elements
            .filter(el => el.geometry)
            .map(el => turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat])));
          setRoadStatus('完了');
          return;
        }
      } catch (err) {
        console.warn(`${endpoint} 接続失敗。再試行中...`);
      }
    }
    setRoadStatus('自由移動');
  };

  const enableDragConfigMarker = () => {
    if (!leafletMap.current) return;
    leafletMap.current.dragging.enable();

    if (!configMarkerRef.current) {
      configMarkerRef.current = L.marker([initLat, initLng], { draggable: true }).addTo(leafletMap.current);
      configMarkerRef.current.bindPopup('ドラッグして初期位置を指定').openPopup();
      configMarkerRef.current.on('dragend', (e) => {
        const latlng = e.target.getLatLng();
        setInitLat(parseFloat(latlng.lat.toFixed(4)));
        setInitLng(parseFloat(latlng.lng.toFixed(4)));
      });
    }
  };

  const disableDragConfigMarker = () => {
    if (configMarkerRef.current && leafletMap.current) {
      leafletMap.current.removeLayer(configMarkerRef.current);
      configMarkerRef.current = null;
    }
  };

  const setBoundsFromCurrentView = () => {
    if (!leafletMap.current) return;
    const b = leafletMap.current.getBounds();
    const newBounds = {
      minLat: parseFloat(b.getSouth().toFixed(4)),
      maxLat: parseFloat(b.getNorth().toFixed(4)),
      minLng: parseFloat(b.getWest().toFixed(4)),
      maxLng: parseFloat(b.getEast().toFixed(4))
    };
    setBounds(newBounds);
    updateBoundsLayer(newBounds);
  };

  // 設定を適用＆Supabaseに保存
  const applyAndSaveSettings = async () => {
    const newLat = parseFloat(initLat);
    const newLng = parseFloat(initLng);

    currentPos.current = [newLat, newLng];
    leafletMap.current.setView(currentPos.current, 16);
    playerMarker.current.setLatLng(currentPos.current);
    updateBoundsLayer(bounds);
    fetchRoadsWithRetry(bounds);

    // Supabaseに保存
    const { error } = await supabase
      .from('system_settings')
      .upsert({
        id: 'default_config',
        init_lat: newLat,
        init_lng: newLng,
        bounds: bounds,
        updated_at: new Date()
      });

    if (error) {
      alert('設定の保存に失敗しました: ' + error.message);
    } else {
      alert('設定を適用し、Supabaseに保存しました。');
      disableDragConfigMarker();
      setShowSettings(false);
    }
  };

  const handleStart = () => {
    if (leafletMap.current) {
      leafletMap.current.dragging.disable();
      leafletMap.current.doubleClickZoom.disable();
    }
    pathCoordinates.current = [currentPos.current];
    polylineRef.current.setLatLngs(pathCoordinates.current);
    polylineRef.current.isRecording = true;
    setIsRecording(true);
  };

  const handleFinishAndSave = async () => {
    polylineRef.current.isRecording = false;
    setIsRecording(false);

    if (leafletMap.current) {
      leafletMap.current.dragging.enable();
      leafletMap.current.doubleClickZoom.enable();
    }

    if (pathCoordinates.current.length < 2) {
      alert('移動記録が短すぎます。');
      return;
    }

    const autoId = `user_${Math.random().toString(36).substring(2, 10)}`;
    const { error } = await supabase
      .from('evacuation_routes')
      .insert([{ user_name: autoId, route_data: pathCoordinates.current }]);

    if (error) {
      alert('保存に失敗しました: ' + error.message);
    } else {
      alert('避難記録を保存しました。ご協力ありがとうございました！');
      pathCoordinates.current = [];
      polylineRef.current.setLatLngs([]);
    }
  };

  const handleSettingsAuth = () => {
    if (settingsPass === 'Tankyu308B') {
      setSettingsAuth(true);
      enableDragConfigMarker();
    } else {
      alert('パスワードが違います。');
    }
  };

  const handleDashboardAuth = () => {
    if (dashboardPass === 'Tankyu308B') {
      setDashboardAuth(true);
      fetchDashboardData();
    } else {
      alert('パスワードが違います。');
    }
  };

  const fetchDashboardData = async () => {
    const { data, error } = await supabase.from('evacuation_routes').select('*');
    if (!error && data) setRoutesList(data);
  };

  const drawSelectedRoute = (routeData) => {
    dashboardPolylines.current.forEach(line => leafletMap.current.removeLayer(line));
    dashboardPolylines.current = [];

    const line = L.polyline(routeData, { color: '#ff00ff', weight: 5, opacity: 0.9 }).addTo(leafletMap.current);
    dashboardPolylines.current.push(line);
    leafletMap.current.fitBounds(line.getBounds());
  };

  return (
    <div className="map-container">
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* 右上：操作用ボタン */}
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 1000, display: 'flex', gap: '8px' }}>
        <button className="btn btn-clear icon-btn" onClick={() => setShowSettings(true)}>
          <span className="icon icon-gear"></span> 設定
        </button>
        <button className="btn btn-save icon-btn" onClick={() => setShowDashboard(true)}>
          <span className="icon icon-chart"></span> データ
        </button>
      </div>

      {/* 中央上：被験者用ボタン */}
      <div style={{
        position: 'absolute',
        top: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        width: '80%',
        maxWidth: '300px'
      }}>
        {!isRecording ? (
          <button className="btn btn-start" style={{ padding: '16px', fontSize: '18px', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }} onClick={handleStart}>
            避難スタート
          </button>
        ) : (
          <button className="btn btn-stop" style={{ padding: '16px', fontSize: '18px', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }} onClick={handleFinishAndSave}>
            ここで避難完了（保存）
          </button>
        )}
      </div>

      <div ref={joystickRef} id="joystickZone" />

      {/* 設定パネル（地図が見えるようサイドパネル化・透過対応） */}
      {showSettings && (
        <div className="floating-panel" style={{ top: '60px', left: '10px' }}>
          <h3>システム設定</h3>
          {!settingsAuth ? (
            <div>
              <input
                type="password"
                placeholder="パスワード"
                value={settingsPass}
                onChange={(e) => setSettingsPass(e.target.value)}
              />
              <button className="btn btn-save" onClick={handleSettingsAuth}>認証</button>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: '11px', color: '#0066ff', fontWeight: 'bold' }}>
                青いピンをドラッグして初期位置を指定できます。
              </p>
              <label>初期 緯度:</label>
              <input type="number" step="0.0001" value={initLat} onChange={(e) => setInitLat(e.target.value)} />
              <label>初期 経度:</label>
              <input type="number" step="0.0001" value={initLng} onChange={(e) => setInitLng(e.target.value)} />

              <hr />
              <button className="btn btn-clear" style={{ marginBottom: '8px', fontSize: '11px' }} onClick={setBoundsFromCurrentView}>
                今の画面を制限エリアにする
              </button>
              <br />
              <label>南 (minLat):</label>
              <input type="number" step="0.0001" value={bounds.minLat} onChange={(e) => setBounds({...bounds, minLat: parseFloat(e.target.value)})} />
              <label>北 (maxLat):</label>
              <input type="number" step="0.0001" value={bounds.maxLat} onChange={(e) => setBounds({...bounds, maxLat: parseFloat(e.target.value)})} />
              <label>西 (minLng):</label>
              <input type="number" step="0.0001" value={bounds.minLng} onChange={(e) => setBounds({...bounds, minLng: parseFloat(e.target.value)})} />
              <label>東 (maxLng):</label>
              <input type="number" step="0.0001" value={bounds.maxLng} onChange={(e) => setBounds({...bounds, maxLng: parseFloat(e.target.value)})} />

              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button className="btn btn-start" onClick={applyAndSaveSettings}>保存＆適用</button>
              </div>
            </div>
          )}
          <button className="btn btn-clear" style={{ marginTop: '12px' }} onClick={() => { disableDragConfigMarker(); setShowSettings(false); }}>
            閉じる
          </button>
        </div>
      )}

      {/* ダッシュボードパネル */}
      {showDashboard && (
        <div className="floating-panel" style={{ top: '60px', right: '10px' }}>
          <h3>被験者データ 一覧</h3>
          {!dashboardAuth ? (
            <div>
              <input
                type="password"
                placeholder="パスワード"
                value={dashboardPass}
                onChange={(e) => setDashboardPass(e.target.value)}
              />
              <button className="btn btn-save" onClick={handleDashboardAuth}>認証</button>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: '12px' }}>クリックで軌跡をマップ表示:</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {routesList.map((item) => (
                  <button
                    key={item.id}
                    className="btn btn-clear"
                    style={{ textAlign: 'left', background: '#f0f0f0', color: '#333' }}
                    onClick={() => drawSelectedRoute(item.route_data)}
                  >
                    <b>{item.user_name}</b> ({new Date(item.created_at).toLocaleString('ja-JP')})
                  </button>
                ))}
              </div>
            </div>
          )}
          <button className="btn btn-clear" style={{ marginTop: '12px' }} onClick={() => setShowDashboard(false)}>
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}