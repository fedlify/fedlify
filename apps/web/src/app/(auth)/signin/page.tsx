"use client";

import { GoogleOutlined, LoginOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Divider, Form, Input, Typography } from "antd";
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
  // Set when the emailed invitation could not be accepted after signing in; the person reads it, then continues.
  const [inviteProblem, setInviteProblem] = useState<{ message: string; target: string } | null>(null);

  async function onFinish(values: LoginForm) {
    setFormError(null);
    const attempt = () => signIn("credentials", { email: values.email, password: values.password, redirect: false });
    // A CSRF cookie mismatch comes back as ok with ?csrf=true and no session: page-load requests can race to set that
    // cookie. It is not a wrong password, so retry once with a fresh token instead of pretending the sign-in worked.
    const isCsrfFailure = (url?: string | null) => Boolean(url && url.includes("csrf=true"));
    let result = await attempt();
    if (isCsrfFailure(result?.url)) result = await attempt();

    if (isCsrfFailure(result?.url)) {
      setFormError("Sign-in could not be completed. Please reload the page and try again.");
      return;
    }
    if (!result?.ok) {
      setFormError("Invalid email or password.");
      return;
    }

    // Full page load: the in-memory session can still read "signed out" right after signIn, and the app layout
    // would bounce back here. Only same-site paths are followed, so callbackUrl cannot send users elsewhere.
    let safeTarget = callbackUrl.startsWith("/") && !callbackUrl.startsWith("//") && !callbackUrl.startsWith("/\\") ? callbackUrl : "/dashboard";

    if (invite) {
      const accepted = await fetch("/api/v1/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: invite })
      }).catch(() => null);
      const body = accepted ? await accepted.json().catch(() => null) : null;
      if (accepted?.ok) {
        if (body?.siteId) safeTarget = `/sites/${body.siteId}`;
      } else {
        const reasons: Record<number, string> = {
          403: "This invitation was sent to a different email address. Sign in with the address it was sent to, or ask your study lead to invite this one.",
          404: "We could not find this invitation. Ask your study lead to send a new one.",
          409: "This invitation has already been used or is no longer valid. Ask your study lead to send a new one.",
          410: "This invitation has expired. Ask your study lead to send a new one."
        };
        setInviteProblem({ message: (accepted && reasons[accepted.status]) || "The invitation could not be accepted. Ask your study lead to send a new one.", target: safeTarget });
        return;
      }
    }

    window.location.assign(safeTarget);
  }

  return (
    <main className="fedlify-auth-shell">
      <Card className="fedlify-auth-card">
        <Typography.Title level={3}>Sign in to Fedlify</Typography.Title>
        <Typography.Paragraph className="fedlify-muted">
          Access governed federated learning studies, approval records, and NVFLARE releases.
        </Typography.Paragraph>
        {invite ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="You have been invited"
            description="Sign in, or create an account, with the same email address the invitation was sent to."
          />
        ) : null}
        {inviteProblem ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="You are signed in, but the invitation was not accepted"
            description={inviteProblem.message}
            action={<Button size="small" onClick={() => window.location.assign(inviteProblem.target)}>Continue</Button>}
          />
        ) : null}
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
          Need access? <Link href={invite ? `/register?invite=${encodeURIComponent(invite)}` : "/register"}>Create an account</Link>
        </Typography.Paragraph>
      </Card>
    </main>
  );
}
