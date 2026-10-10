export const THEME_STORAGE_KEY = "career-ops:theme";

export const THEME_COLORS = Object.freeze({
  light: "#f7f6f3",
  dark: "#0a0a0a",
});

export function isTheme(value) {
  return value === "light" || value === "dark";
}

export function storedTheme(value, fallback = "dark") {
  return isTheme(value) ? value : fallback;
}
