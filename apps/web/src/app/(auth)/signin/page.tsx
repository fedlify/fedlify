"use client";

import { GoogleOutlined, LoginOutlined } from "@ant-design/icons";
import { Button, Card, Divider, Form, Input, Typography } from "antd";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { FormError } from "@/components/FormFeedback";

type LoginForm = {
  email: string;
  password: string;
};

export default function SignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";
  const invite = searchParams.get("invite");

  async function onFinish(values: LoginForm) {
    setFormError(null);
    const result = await signIn("credentials", {
      email: values.email,
      password: values.password,
      redirect: false
    });

    if (!result?.ok) {
      setFormError("Invalid email or password.");
      return;
    }

    if (invite) {
      await fetch("/api/v1/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: invite })
      });
    }

    router.push(callbackUrl);
  }

  return (
    <main className="fedlify-auth-shell">
      <Card className="fedlify-auth-card">
        <Typography.Title level={3}>Sign in to Fedlify</Typography.Title>
        <Typography.Paragraph className="fedlify-muted">
          Access governed federated learning studies, approval records, and NVFLARE releases.
        </Typography.Paragraph>
        <Form layout="vertical" onFinish={onFinish}>
          <FormError title="Sign-in failed" message={formError} />
          <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}>
            <Input autoComplete="email" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<LoginOutlined />} block>
            Sign in
          </Button>
        </Form>
        <Divider />
        <Button icon={<GoogleOutlined />} block onClick={() => signIn("google", { callbackUrl })}>
          Continue with Google
        </Button>
        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          Need access? <Link href="/register">Create an account</Link>
        </Typography.Paragraph>
      </Card>
    </main>
  );
}
