import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable}`}>
      <Component {...pageProps} />
    </div>
  );
}
