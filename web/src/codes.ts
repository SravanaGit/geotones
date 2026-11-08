// Private-drop codes this device has entered. Kept locally so private drops stay on the map.
const KEY = 'geotones.codes';

export function loadCodes(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveCodes(codes: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(codes));
  } catch {
    // Private browsing can block storage; codes then last until the page closes.
  }
}

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
