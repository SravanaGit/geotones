import { useEffect, useState } from 'react';

export type Position = { lat: number; lng: number; accuracy: number };

// Follows the device's location for as long as a map is on screen.
export function usePosition() {
  const [position, setPosition] = useState<Position | null>(null);
  const [locationError, setLocationError] = useState('');

  useEffect(() => {
    if (!navigator.geolocation) return setLocationError('This browser can’t share your location.');
    const watch = navigator.geolocation.watchPosition(
      ({ coords }) => {
        setLocationError('');
        setPosition({ lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy });
      },
      (e) => setLocationError(e.code === e.PERMISSION_DENIED
        ? 'Allow location access to use your location.'
        : 'Can’t find your location yet.'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  return { position, locationError };
}
