import type { Metadata } from "next";
import { Suspense } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import "antd/dist/reset.css";
import "@/styles/globals.css";
import { ClientProviders } from "@/providers/client-providers";

export const metadata: Metadata = {
  title: "Fedlify",
  description: "Governed health AI federated learning control plane."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <Suspense fallback={null}>
            <ClientProviders>{children}</ClientProviders>
          </Suspense>
        </AntdRegistry>
      </body>
    </html>
  );
}
