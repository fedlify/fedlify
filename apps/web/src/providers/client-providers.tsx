"use client";

import { App as AntdApp, ConfigProvider, theme } from "antd";
import { Refine } from "@refinedev/core";
import routerProvider from "@refinedev/nextjs-router";
import { SessionProvider } from "next-auth/react";
import { accessControlProvider } from "@/providers/access-control-provider";
import { authProvider } from "@/providers/auth-provider";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ConfigProvider
        theme={{
          algorithm: theme.defaultAlgorithm,
          token: {
            colorPrimary: "#8576B5",
            colorPrimaryHover: "#7160A8",
            colorPrimaryActive: "#5F5090",
            colorText: "#2F3040",
            colorTextSecondary: "#687086",
            colorBgLayout: "#F7F5FB",
            borderRadius: 14,
            fontSize: 14,
            fontSizeHeading1: 28,
            fontSizeHeading2: 18,
            fontSizeHeading3: 16,
            fontSizeHeading4: 16,
            fontFamily:
              "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
          },
          components: {
            Button: {
              controlHeight: 36,
              fontWeight: 600
            },
            Menu: {
              itemBorderRadius: 10,
              itemHeight: 38,
              itemMarginInline: 6,
              itemSelectedBg: "#ECE7F6",
              itemSelectedColor: "#7160A8"
            },
            Segmented: {
              itemSelectedBg: "#ffffff"
            }
          }
        }}
      >
        <AntdApp>
          <Refine
            routerProvider={routerProvider}
            authProvider={authProvider}
            accessControlProvider={accessControlProvider}
            resources={[
              { name: "dashboard", list: "/dashboard", meta: { label: "Dashboard" } },
              { name: "studies", list: "/studies/manage", show: "/studies/:studyId", meta: { label: "Studies" } },
              { name: "audit", list: "/dashboard", meta: { label: "Audit" } }
            ]}
            options={{ syncWithLocation: true, warnWhenUnsavedChanges: true }}
          >
            {children}
          </Refine>
        </AntdApp>
      </ConfigProvider>
    </SessionProvider>
  );
}
