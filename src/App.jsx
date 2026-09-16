import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import nipplejs from 'nipplejs';
import * as turf from '@turf/turf';
import { supabase } from './lib/supabase';
import './App.css';

// ローカルGeoJSONのインポート
import localRoadsData from './assets/roads.json';

// ==========================================
// 📝 モーダルの文章設定（改行は \n またはそのまま改行で反映されます）
// ==========================================
const WELCOME_MESSAGE = {
  title: '避難シミュレーションへようこそ！',
  body: `このアプリは、マップ上で避難経路や時間を記録・分析するためのツールです。

【使い方】
1. 「避難スタート」を押して移動を開始します。
2. キーボード（WASD / 矢印キー）または画面左下のジョイスティックで操作します。
3. 避難所に到着したら「避難完了」を押して記録を保存します。`
};

const THANK_YOU_MESSAGE = {
  title: '避難シミュレーション完了！',
  body: `データが正常に保存されました。

実験へのご協力、ありがとうございました！`
};

// ==========================================
// 🎨 SVG アイコンコンポーネント
// ==========================================
const TimerIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const PauseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const DEFAULT_LAT = 34.4825;
const DEFAULT_LNG = 132.5180;
const DEFAULT_SPEED = 5;
const DEFAULT_BOUNDS = {
  minLat: 34.4700,
  maxLat: 34.4950,
  minLng: 132.5000,
  maxLng: 132.5350
};

const DEFAULT_SHELTERS = [
  { id: '1', name: '深川小学校', lat: 34.4830, lng: 132.5190 },
  { id: '2', name: '安佐北区スポーツセンター', lat: 34.4865, lng: 132.5145 },
  { id: '3', name: '可部南小学校', lat: 34.4910, lng: 132.5110 }
];

const MAP_COLORS = {
  A: '#ff3b30',
  B: '#007aff',
  C: '#34c759',
  D: '#af52de',
  E: '#ff9500',
  default: '#8e8e93'
};

export default function App() {
  const mapRef = useRef(null);
  const joystickRef = useRef(null);
  const leafletMap = useRef(null);
  const playerMarker = useRef(null);
  const playbackMarkerRef = useRef(null);
  const configMarkerRef = useRef(null);
  const shelterMarkersRef = useRef({});
  const polylineRef = useRef(null);
  const boundsLayerRef = useRef(null);
  const activePolylineRef = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const [roadStatus, setRoadStatus] = useState('loading');

  // モーダル管理
  const [showWelcomeModal, setShowWelcomeModal] = useState(true);
  const [showThankYouModal, setShowThankYouModal] = useState(false);

  // ストップウォッチ用
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef(null);

  // 設定用
  const [showSettings, setShowSettings] = useState(false);
  const [settingsAuth, setSettingsAuth] = useState(false);
  const [settingsPass, setSettingsPass] = useState('');
  const [initLat, setInitLat] = useState(DEFAULT_LAT);
  const [initLng, setInitLng] = useState(DEFAULT_LNG);
  const [moveSpeed, setMoveSpeed] = useState(DEFAULT_SPEED);
  const [bounds, setBounds] = useState(DEFAULT_BOUNDS);
  const [shelters, setShelters] = useState(DEFAULT_SHELTERS);

  // ダッシュボード用
  const [showDashboard, setShowDashboard] = useState(false);
  const [dashboardAuth, setDashboardAuth] = useState(false);
  const [dashboardPass, setDashboardPass] = useState('');
  const [routesList, setRoutesList] = useState([]);
  const [selectedFilter, setSelectedFilter] = useState('ALL');
  const [activeRoute, setActiveRoute] = useState(null);

  // 再生プレイヤー用
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const playbackTimerRef = useRef(null);

  const currentPos = useRef([DEFAULT_LAT, DEFAULT_LNG]);
  const pathCoordinates = useRef([]);
  const roadFeatures = useRef([]);
  const moveVector = useRef({ x: 0, y: 0 });
  const boundsRef = useRef(bounds);
  const moveSpeedRef = useRef(moveSpeed);

  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    moveSpeedRef.current = moveSpeed;
  }, [moveSpeed]);

  useEffect(() => {
    if (!mapRef.current || !joystickRef.current) return;

    const map = L.map(mapRef.current, {
      dragging: true,
      zoomControl: false,
      doubleClickZoom: true
    }).setView(currentPos.current, 16);

    leafletMap.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    const playerIcon = L.divIcon({ className: 'player-icon', iconSize: [20, 20], iconAnchor: [10, 10] });
    playerMarker.current = L.marker(currentPos.current, { icon: playerIcon }).addTo(map);
    polylineRef.current = L.polyline([], { color: '#007aff', weight: 6, opacity: 0.85 }).addTo(map);

    loadSettingsFromSupabase();

    const manager = nipplejs.create({
      zone: joystickRef.current,
      mode: 'static',
      position: { left: '60px', bottom: '60px' },
      color: '#007aff',
      size: 90
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

    function gameLoop(timestamp) {
      if (moveVector.current.x !== 0 || moveVector.current.y !== 0) {
        const baseSpeed = 0.0000015 * moveSpeedRef.current;

        let targetLat = currentPos.current[0] + (moveVector.current.y * baseSpeed);
        let targetLng = currentPos.current[1] + (moveVector.current.x * baseSpeed);

        const currentBounds = boundsRef.current;

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
            targetLat = closestSnap.geometry.coordinates[1];
            targetLng = closestSnap.geometry.coordinates[0];
          }
        }

        targetLat = Math.max(currentBounds.minLat, Math.min(currentBounds.maxLat, targetLat));
        targetLng = Math.max(currentBounds.minLng, Math.min(currentBounds.maxLng, targetLng));

        currentPos.current = [targetLat, targetLng];
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

  // 再生ロジック
  useEffect(() => {
    if (isPlaying && activeRoute && activeRoute.route_data) {
      playbackTimerRef.current = setInterval(() => {
        setPlaybackIndex((prev) => {
          if (prev >= activeRoute.route_data.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 200 / playbackSpeed);
    } else {
      clearInterval(playbackTimerRef.current);
    }

    return () => clearInterval(playbackTimerRef.current);
  }, [isPlaying, activeRoute, playbackSpeed]);

  useEffect(() => {
    if (activeRoute && activeRoute.route_data && activeRoute.route_data[playbackIndex]) {
      const pos = activeRoute.route_data[playbackIndex];
      if (!playbackMarkerRef.current) {
        const icon = L.divIcon({ className: 'player-icon', iconSize: [20, 20], iconAnchor: [10, 10] });
        playbackMarkerRef.current = L.marker(pos, { icon }).addTo(leafletMap.current);
      } else {
        playbackMarkerRef.current.setLatLng(pos);
      }
    }
  }, [playbackIndex, activeRoute]);

  const updateShelterMarkers = (shelterList, isDraggable = false) => {
    if (!leafletMap.current) return;

    Object.values(shelterMarkersRef.current).forEach(marker => leafletMap.current.removeLayer(marker));
    shelterMarkersRef.current = {};

    const shelterIcon = L.icon({
      iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
      shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
      shadowSize: [41, 41]
    });

    shelterList.forEach(shelter => {
      const marker = L.marker([shelter.lat, shelter.lng], {
        icon: shelterIcon,
        draggable: isDraggable
      }).addTo(leafletMap.current);

      marker.bindPopup(`<b>避難所</b><br>${shelter.name}`);

      if (isDraggable) {
        marker.on('dragend', (e) => {
          const newPos = e.target.getLatLng();
          setShelters(prev => prev.map(item =>
            item.id === shelter.id ? { ...item, lat: parseFloat(newPos.lat.toFixed(4)), lng: parseFloat(newPos.lng.toFixed(4)) } : item
          ));
        });
      }

      shelterMarkersRef.current[shelter.id] = marker;
    });
  };

  const loadSettingsFromSupabase = async () => {
    loadLocalRoadGeoJSON();

    const { data, error } = await supabase
      .from('system_settings')
      .select('*')
      .eq('id', 'default_config')
      .single();

    if (!error && data) {
      const lat = parseFloat(data.init_lat);
      const lng = parseFloat(data.init_lng);
      const speed = data.speed ? parseInt(data.speed, 10) : DEFAULT_SPEED;
      const loadedShelters = data.shelters || DEFAULT_SHELTERS;

      setInitLat(lat);
      setInitLng(lng);
      setMoveSpeed(speed);
      setBounds(data.bounds);
      setShelters(loadedShelters);

      currentPos.current = [lat, lng];
      if (leafletMap.current) {
        leafletMap.current.setView([lat, lng], 16);
        playerMarker.current.setLatLng([lat, lng]);
        updateBoundsLayer(data.bounds);
        updateShelterMarkers(loadedShelters, false);
      }
    } else {
      updateBoundsLayer(bounds);
      updateShelterMarkers(shelters, false);
    }
  };

  const loadLocalRoadGeoJSON = () => {
    try {
      if (localRoadsData && localRoadsData.features) {
        roadFeatures.current = localRoadsData.features.filter(
          f => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')
        );
      }
      setRoadStatus('ready');
    } catch (e) {
      setRoadStatus('ready');
    }
  };

  const updateBoundsLayer = (b) => {
    if (!leafletMap.current) return;
    if (boundsLayerRef.current) leafletMap.current.removeLayer(boundsLayerRef.current);
    boundsLayerRef.current = L.rectangle([
      [b.minLat, b.minLng],
      [b.maxLat, b.maxLng]
    ], { color: '#ff3b30', weight: 2, fill: false, dashArray: '6, 8' }).addTo(leafletMap.current);
  };

  const enableDragConfigMarker = () => {
    if (!leafletMap.current) return;
    leafletMap.current.dragging.enable();

    if (!configMarkerRef.current) {
      configMarkerRef.current = L.marker([initLat, initLng], { draggable: true }).addTo(leafletMap.current);
      configMarkerRef.current.bindPopup('初期位置').openPopup();
      configMarkerRef.current.on('dragend', (e) => {
        const latlng = e.target.getLatLng();
        setInitLat(parseFloat(latlng.lat.toFixed(4)));
        setInitLng(parseFloat(latlng.lng.toFixed(4)));
      });
    }

    updateShelterMarkers(shelters, true);
  };

  const disableDragConfigMarker = () => {
    if (configMarkerRef.current && leafletMap.current) {
      leafletMap.current.removeLayer(configMarkerRef.current);
      configMarkerRef.current = null;
    }
    updateShelterMarkers(shelters, false);
  };

  const handleAddShelter = () => {
    const newShelter = {
      id: Date.now().toString(),
      name: `新規避難所 ${shelters.length + 1}`,
      lat: initLat,
      lng: initLng
    };
    const updated = [...shelters, newShelter];
    setShelters(updated);
    updateShelterMarkers(updated, true);
  };

  const handleRemoveShelter = (id) => {
    const updated = shelters.filter(s => s.id !== id);
    setShelters(updated);
    updateShelterMarkers(updated, true);
  };

  const handleShelterNameChange = (id, name) => {
    const updated = shelters.map(s => s.id === id ? { ...s, name } : s);
    setShelters(updated);
    updateShelterMarkers(updated, true);
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

  const applyAndSaveSettings = async () => {
    const newLat = parseFloat(initLat);
    const newLng = parseFloat(initLng);

    currentPos.current = [newLat, newLng];
    leafletMap.current.setView(currentPos.current, 16);
    playerMarker.current.setLatLng(currentPos.current);
    updateBoundsLayer(bounds);

    const { error } = await supabase
      .from('system_settings')
      .upsert({
        id: 'default_config',
        init_lat: newLat,
        init_lng: newLng,
        speed: moveSpeed,
        bounds: bounds,
        shelters: shelters,
        updated_at: new Date()
      });

    if (error) {
      alert('保存失敗: ' + error.message);
    } else {
      alert('設定をSupabaseに保存しました。');
      disableDragConfigMarker();
      setShowSettings(false);
    }
  };

  const handleStart = () => {
    clearPlayback();
    if (leafletMap.current) {
      leafletMap.current.dragging.disable();
      leafletMap.current.doubleClickZoom.disable();
    }
    pathCoordinates.current = [currentPos.current];
    polylineRef.current.setLatLngs(pathCoordinates.current);
    polylineRef.current.isRecording = true;
    setIsRecording(true);

    setElapsedTime(0);
    timerRef.current = setInterval(() => {
      setElapsedTime(prev => prev + 1);
    }, 1000);
  };

  const handleFinishAndSave = async () => {
    polylineRef.current.isRecording = false;
    setIsRecording(false);
    clearInterval(timerRef.current);

    if (leafletMap.current) {
      leafletMap.current.dragging.enable();
      leafletMap.current.doubleClickZoom.enable();
    }

    if (pathCoordinates.current.length < 2) {
      alert('記録が不十分です。');
      return;
    }

    const queryParams = new URLSearchParams(window.location.search);
    const mapType = queryParams.get('map') || 'default';

    const autoId = `user_${Math.random().toString(36).substring(2, 8)}`;
    const { error } = await supabase
      .from('evacuation_routes')
      .insert([{
        user_name: autoId,
        route_data: pathCoordinates.current,
        map_type: mapType,
        duration_sec: elapsedTime
      }]);

    if (error) {
      alert('保存失敗: ' + error.message);
    } else {
      pathCoordinates.current = [];
      polylineRef.current.setLatLngs([]);
      setShowThankYouModal(true);
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
    const { data, error } = await supabase.from('evacuation_routes').select('*').order('created_at', { ascending: false });
    if (!error && data) setRoutesList(data);
  };

  const clearPlayback = () => {
    if (activePolylineRef.current) {
      leafletMap.current.removeLayer(activePolylineRef.current);
      activePolylineRef.current = null;
    }
    if (playbackMarkerRef.current) {
      leafletMap.current.removeLayer(playbackMarkerRef.current);
      playbackMarkerRef.current = null;
    }
    setActiveRoute(null);
    setIsPlaying(false);
    setPlaybackIndex(0);
  };

  const selectRouteForPlayback = (route) => {
    if (activeRoute && activeRoute.id === route.id) {
      clearPlayback();
      return;
    }

    clearPlayback();

    const lineColor = MAP_COLORS[route.map_type] || MAP_COLORS.default;
    const polyline = L.polyline(route.route_data, { color: lineColor, weight: 6, opacity: 0.9 }).addTo(leafletMap.current);
    activePolylineRef.current = polyline;
    leafletMap.current.fitBounds(polyline.getBounds());

    setActiveRoute(route);
    setPlaybackIndex(0);
  };

  const handleDeleteRoute = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('この避難データを削除してよろしいですか？')) return;

    const { error } = await supabase.from('evacuation_routes').delete().eq('id', id);
    if (error) {
      alert('削除失敗: ' + error.message);
    } else {
      if (activeRoute && activeRoute.id === id) clearPlayback();
      setRoutesList(prev => prev.filter(item => item.id !== id));
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const mapTypeOptions = ['ALL', ...Array.from(new Set(routesList.map(r => r.map_type || 'default')))];
  const filteredRoutes = routesList.filter(r => selectedFilter === 'ALL' || (r.map_type || 'default') === selectedFilter);

  return (
    <div className="map-container">
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* 右上：設定＆データボタン */}
      <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 1000, display: 'flex', gap: '10px' }}>
        <button className="btn btn-glass" onClick={() => setShowSettings(true)}>
          設定
        </button>
        <button className="btn btn-glass" onClick={() => setShowDashboard(true)}>
          データ
        </button>
      </div>

      {/* 中央上：スタート / ゴールボタン ＋ ストップウォッチ */}
      <div style={{
        position: 'absolute',
        top: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        width: '85%',
        maxWidth: '320px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px'
      }}>
        {!isRecording ? (
          <button
            className="btn btn-start"
            style={{
              width: '100%',
              padding: '16px',
              fontSize: '17px',
              boxShadow: '0 8px 25px rgba(40, 199, 111, 0.35)',
              opacity: roadStatus === 'loading' ? 0.6 : 1,
              cursor: roadStatus === 'loading' ? 'not-allowed' : 'pointer'
            }}
            onClick={handleStart}
            disabled={roadStatus === 'loading'}
          >
            {roadStatus === 'loading' ? '道路データ準備中...' : '避難スタート'}
          </button>
        ) : (
          <>
            {/* ストップウォッチ（SVGタイマーアイコン） */}
            <div style={{
              background: 'rgba(0, 0, 0, 0.75)',
              color: '#4cd964',
              padding: '6px 20px',
              borderRadius: '20px',
              fontSize: '22px',
              fontWeight: 'bold',
              fontFamily: 'monospace',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              backdropFilter: 'blur(5px)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <TimerIcon />
              <span>{formatTime(elapsedTime)}</span>
            </div>
            <button
              className="btn btn-stop"
              style={{ width: '100%', padding: '16px', fontSize: '17px', boxShadow: '0 8px 25px rgba(234, 84, 85, 0.35)' }}
              onClick={handleFinishAndSave}
            >
              避難完了（保存）
            </button>
          </>
        )}
      </div>

      <div ref={joystickRef} id="joystickZone" />

      {/* 画面下部：データ再生バー */}
      {activeRoute && (
        <div style={{
          position: 'absolute',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1000,
          width: '90%',
          maxWidth: '450px',
          background: 'rgba(255, 255, 255, 0.95)',
          padding: '12px 18px',
          borderRadius: '16px',
          boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
          backdropFilter: 'blur(10px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2d3748', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <PlayIcon /> 避難再現: {activeRoute.user_name} ({activeRoute.map_type || 'default'})
            </span>
            <button className="btn btn-glass" style={{ padding: '2px 8px', fontSize: '10px' }} onClick={clearPlayback}>
              閉じる
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              className="btn btn-glass"
              style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => setIsPlaying(!isPlaying)}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>

            <input
              type="range"
              min="0"
              max={activeRoute.route_data.length - 1}
              value={playbackIndex}
              onChange={(e) => setPlaybackIndex(Number(e.target.value))}
              style={{ flex: 1 }}
            />

            <button
              className="btn btn-glass"
              style={{ padding: '4px 8px', fontSize: '11px' }}
              onClick={() => setPlaybackSpeed(s => s === 1 ? 2 : s === 2 ? 4 : 1)}
            >
              {playbackSpeed}x
            </button>
          </div>
        </div>
      )}

      {/* 1. 初回説明モーダル */}
      {showWelcomeModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          backgroundColor: 'rgba(0,0,0,0.5)',
          zIndex: 2000,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '20px'
        }}>
          <div style={{
            background: '#fff',
            borderRadius: '16px',
            padding: '24px',
            maxWidth: '420px',
            width: '100%',
            boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
            textAlign: 'left'
          }}>
            <h2 style={{ margin: '0 0 12px 0', fontSize: '18px', color: '#2d3748' }}>{WELCOME_MESSAGE.title}</h2>
            <p style={{
              fontSize: '13px',
              color: '#4a5568',
              lineHeight: '1.6',
              whiteSpace: 'pre-wrap',
              margin: '0 0 20px 0'
            }}>
              {WELCOME_MESSAGE.body}
            </p>
            <button
              className="btn btn-start"
              style={{ width: '100%', padding: '12px', fontSize: '15px' }}
              onClick={() => setShowWelcomeModal(false)}
            >
              実験を始める
            </button>
          </div>
        </div>
      )}

      {/* 2. 終了感謝モーダル */}
      {showThankYouModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          backgroundColor: 'rgba(0,0,0,0.5)',
          zIndex: 2000,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '20px'
        }}>
          <div style={{
            background: '#fff',
            borderRadius: '16px',
            padding: '24px',
            maxWidth: '420px',
            width: '100%',
            boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
            textAlign: 'center'
          }}>
            <h2 style={{ margin: '0 0 12px 0', fontSize: '18px', color: '#2d3748' }}>{THANK_YOU_MESSAGE.title}</h2>
            <p style={{
              fontSize: '14px',
              color: '#4a5568',
              lineHeight: '1.6',
              whiteSpace: 'pre-wrap',
              margin: '0 0 20px 0'
            }}>
              {THANK_YOU_MESSAGE.body}
            </p>
            <button
              className="btn btn-start"
              style={{ width: '100%', padding: '12px', fontSize: '15px' }}
              onClick={() => setShowThankYouModal(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 設定パネル */}
      {showSettings && (
        <div className="floating-panel" style={{ top: '65px', left: '16px' }}>
          <h3>システム設定</h3>
          {!settingsAuth ? (
            <div>
              <input
                type="password"
                placeholder="パスワードを入力"
                value={settingsPass}
                onChange={(e) => setSettingsPass(e.target.value)}
              />
              <button className="btn btn-start" style={{ width: '100%', marginTop: '4px' }} onClick={handleSettingsAuth}>
                認証
              </button>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: '11px', color: '#3182ce', fontWeight: '700', marginBottom: '10px' }}>
                マップ上の青ピン・緑ピンをドラッグして動かせます。
              </p>

              <div style={{ marginBottom: '12px', textAlign: 'left' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold' }}>移動速度: Lv.{moveSpeed}</label>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={moveSpeed}
                  onChange={(e) => setMoveSpeed(Number(e.target.value))}
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </div>

              <label>初期位置（緯度 / 経度）:</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input type="number" step="0.0001" value={initLat} onChange={(e) => setInitLat(e.target.value)} />
                <input type="number" step="0.0001" value={initLng} onChange={(e) => setInitLng(e.target.value)} />
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid #edf2f7', margin: '12px 0' }} />

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <label style={{ margin: 0 }}>避難所リスト ({shelters.length}):</label>
                <button className="btn btn-glass" style={{ padding: '2px 8px', fontSize: '11px' }} onClick={handleAddShelter}>
                  + 追加
                </button>
              </div>

              <div style={{ maxHeight: '160px', overflowY: 'auto' }}>
                {shelters.map((s) => (
                  <div key={s.id} className="shelter-item-edit">
                    <input
                      type="text"
                      value={s.name}
                      placeholder="避難所名"
                      onChange={(e) => handleShelterNameChange(s.id, e.target.value)}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '10px', color: '#a0aec0' }}>{s.lat}, {s.lng}</span>
                      <button className="btn btn-danger" style={{ padding: '2px 6px', fontSize: '10px' }} onClick={() => handleRemoveShelter(s.id)}>
                        削除
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid #edf2f7', margin: '12px 0' }} />

              <button className="btn btn-glass" style={{ width: '100%', marginBottom: '8px', fontSize: '11px' }} onClick={setBoundsFromCurrentView}>
                現在の表示画面を制限エリアにする
              </button>

              <button className="btn btn-start" style={{ width: '100%', marginTop: '8px' }} onClick={applyAndSaveSettings}>
                設定をSupabaseに保存
              </button>
            </div>
          )}
          <button className="btn btn-glass" style={{ width: '100%', marginTop: '10px' }} onClick={() => { disableDragConfigMarker(); setShowSettings(false); }}>
            閉じる
          </button>
        </div>
      )}

      {/* ダッシュボードパネル */}
      {showDashboard && (
        <div className="floating-panel" style={{ top: '65px', right: '16px', width: '340px', padding: '16px' }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', textAlign: 'left' }}>避難データ分析</h3>
          {!dashboardAuth ? (
            <div>
              <input
                type="password"
                placeholder="パスワードを入力"
                value={dashboardPass}
                onChange={(e) => setDashboardPass(e.target.value)}
              />
              <button className="btn btn-start" style={{ width: '100%', marginTop: '6px' }} onClick={handleDashboardAuth}>
                認証
              </button>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: '12px' }}>
                <span style={{ fontSize: '11px', color: '#718096', display: 'block', marginBottom: '4px', textAlign: 'left' }}>
                  マップ種別で絞り込み:
                </span>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {mapTypeOptions.map(type => (
                    <button
                      key={type}
                      className="btn btn-glass"
                      style={{
                        padding: '3px 10px',
                        fontSize: '11px',
                        backgroundColor: selectedFilter === type ? '#007aff' : 'rgba(255,255,255,0.8)',
                        color: selectedFilter === type ? '#fff' : '#000',
                        border: '1px solid rgba(0,0,0,0.1)'
                      }}
                      onClick={() => setSelectedFilter(type)}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px', overflowY: 'auto' }}>
                {filteredRoutes.map((item) => {
                  const mType = item.map_type || 'default';
                  const badgeColor = MAP_COLORS[mType] || MAP_COLORS.default;
                  const isSelected = activeRoute && activeRoute.id === item.id;

                  return (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        background: isSelected ? 'rgba(0, 122, 255, 0.12)' : 'rgba(255, 255, 255, 0.8)',
                        border: isSelected ? '1.5px solid #007aff' : '1px solid rgba(0, 0, 0, 0.08)',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        boxSizing: 'border-box'
                      }}
                      onClick={() => selectRouteForPlayback(item)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                        <span style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          backgroundColor: badgeColor,
                          flexShrink: 0
                        }} />
                        <div style={{ textAlign: 'left' }}>
                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#2d3748' }}>
                            {item.user_name}
                            <span style={{ fontSize: '11px', color: '#3182ce', marginLeft: '6px' }}>
                              [{mType}]
                            </span>
                          </div>
                          <div style={{ fontSize: '10px', color: '#a0aec0', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            {item.duration_sec ? (
                              <>
                                <TimerIcon />
                                <span>{formatTime(item.duration_sec)} | </span>
                              </>
                            ) : null}
                            <span>{new Date(item.created_at).toLocaleString('ja-JP')}</span>
                          </div>
                        </div>
                      </div>

                      <button
                        className="btn btn-danger"
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          flexShrink: 0,
                          marginLeft: '12px'
                        }}
                        onClick={(e) => handleDeleteRoute(item.id, e)}
                      >
                        削除
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <button className="btn btn-glass" style={{ width: '100%', marginTop: '12px' }} onClick={() => setShowDashboard(false)}>
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}