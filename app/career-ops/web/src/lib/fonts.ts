import localFont from "next/font/local";

export const inter = localFont({
  src: [{
    path: "../assets/fonts/inter/Inter-Latin-Variable.woff2",
    weight: "100 900",
    style: "normal",
  }],
  variable: "--font-inter",
  display: "swap",
});

export const instrumentSerif = localFont({
  src: [{
    path: "../assets/fonts/instrument-serif/InstrumentSerif-Latin-Regular.woff2",
    weight: "400",
    style: "normal",
  }],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const instrumentSerifItalic = localFont({
  src: [{
    path: "../assets/fonts/instrument-serif/InstrumentSerif-Latin-Italic.woff2",
    weight: "400",
    style: "italic",
  }],
  variable: "--font-instrument-serif-italic",
  display: "swap",
});
