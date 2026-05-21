"use client";

import { Alert } from "antd";

type FormErrorProps = {
  title: string;
  message?: string | null;
};

export function FormError({ title, message }: FormErrorProps) {
  if (!message) return null;
  return <Alert className="fedlify-inline-alert" type="error" showIcon message={title} description={message} />;
}
