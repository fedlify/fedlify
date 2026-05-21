import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";

export function auth() {
  return getServerSession(authOptions);
}
