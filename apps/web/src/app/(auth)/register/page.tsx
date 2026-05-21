"use client";

import { UserAddOutlined } from "@ant-design/icons";
import { Button, Card, Form, Input, Typography, message } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormError } from "@/components/FormFeedback";

type RegisterForm = {
  name: string;
  email: string;
  password: string;
};

export default function RegisterPage() {
  const router = useRouter();
  const [messageApi, contextHolder] = message.useMessage();
  const [formError, setFormError] = useState<string | null>(null);

  async function onFinish(values: RegisterForm) {
    setFormError(null);
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values)
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setFormError(body?.error?.message ?? "Account registration could not be completed.");
      return;
    }

    messageApi.success("Account created. Sign in to continue.");
    router.push("/signin");
  }

  return (
    <main className="fedlify-auth-shell">
      {contextHolder}
      <Card className="fedlify-auth-card">
        <Typography.Title level={3}>Create Fedlify account</Typography.Title>
        <Typography.Paragraph className="fedlify-muted">
          A default governed study workspace is created automatically after registration.
        </Typography.Paragraph>
        <Form layout="vertical" onFinish={onFinish}>
          <FormError title="Account was not created" message={formError} />
          <Form.Item name="name" label="Full name" rules={[{ required: true, min: 2 }]}>
            <Input autoComplete="name" />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
            <Input autoComplete="email" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, min: 12, message: "Use at least 12 characters." }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<UserAddOutlined />} block>
            Create account
          </Button>
        </Form>
        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          Already have an account? <Link href="/signin">Sign in</Link>
        </Typography.Paragraph>
      </Card>
    </main>
  );
}
