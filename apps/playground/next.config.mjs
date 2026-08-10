/** @type {import('next').NextConfig} */
const nextConfig = {
  // ワークスペース内のパッケージは dist（ビルド済み ESM）を読む。
  // 実際のアプリと同じ経路で読み込ませたいので transpilePackages は使わない。
  reactStrictMode: true,
};

export default nextConfig;
