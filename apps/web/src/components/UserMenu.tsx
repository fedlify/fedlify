"use client";

import {
  BookOutlined,
  LogoutOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  UserOutlined
} from "@ant-design/icons";
import { Button, Dropdown, Typography } from "antd";
import Image from "next/image";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

function initialsFor(name?: string | null, email?: string | null) {
  const source = name?.trim() || email?.split("@")[0] || "User";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function UserAvatar({
  image,
  name,
  email,
  large = false
}: {
  image?: string | null;
  name?: string | null;
  email?: string | null;
  large?: boolean;
}) {
  const label = name || email || "Fedlify user";

  return (
    <span className={`fedlify-user-avatar${large ? " is-large" : ""}`} aria-label={label}>
      {image ? <Image src={image} alt="" width={large ? 46 : 34} height={large ? 46 : 34} unoptimized /> : <span>{initialsFor(name, email)}</span>}
    </span>
  );
}

export function UserMenu() {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const name = session?.user?.name || "Fedlify user";
  const email = session?.user?.email || "Signed in";
  const image = session?.user?.image;

  const dropdown = (
      <div className="fedlify-user-menu">
      <div className="fedlify-user-menu-profile">
        <UserAvatar image={image} name={name} email={email} large />
        <div>
          <Typography.Title level={4}>{name}</Typography.Title>
          <Typography.Text>{email}</Typography.Text>
        </div>
      </div>

      <div className="fedlify-user-menu-divider" />

      <button
        type="button"
        className="fedlify-user-menu-item"
        onClick={() => {
          setOpen(false);
          router.push("/profile");
        }}
      >
        <UserOutlined />
        <span>Profile</span>
      </button>
      <button
        type="button"
        className="fedlify-user-menu-item"
        onClick={() => {
          setOpen(false);
          router.push("/studies/manage");
        }}
      >
        <SettingOutlined />
        <span>Study management</span>
      </button>

      <div className="fedlify-user-menu-divider" />

      <button type="button" className="fedlify-user-menu-item">
        <SafetyCertificateOutlined />
        <span>Policies</span>
      </button>
      <button type="button" className="fedlify-user-menu-item">
        <QuestionCircleOutlined />
        <span>Help</span>
      </button>
      <button type="button" className="fedlify-user-menu-item">
        <BookOutlined />
        <span>Documentation</span>
      </button>

      <div className="fedlify-user-menu-divider" />

      <button
        type="button"
        className="fedlify-user-menu-item is-danger"
        onClick={() => {
          setOpen(false);
          void signOut({ callbackUrl: "/signin" });
        }}
      >
        <LogoutOutlined />
        <span>Sign out</span>
      </button>
    </div>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      dropdownRender={() => dropdown}
      trigger={["click"]}
      placement="bottomRight"
    >
      <Button className="fedlify-user-menu-trigger" aria-label="Open user menu">
        <UserAvatar image={image} name={name} email={email} />
      </Button>
    </Dropdown>
  );
}
