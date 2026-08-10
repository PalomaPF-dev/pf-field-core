import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "pf-field-core playground",
  description: "オフライン・アップロード基盤の検証用アプリ",
};

export const viewport: Viewport = {
  // ハンディ端末の実機で開く前提。横スクロールを出さない
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
