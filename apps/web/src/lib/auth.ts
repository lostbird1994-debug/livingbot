import { passkeyClient } from "@better-auth/passkey/client";
import type { OrganizationClientOptions } from "better-auth/client/plugins";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import type { ReactAuthClient } from "better-auth/react";
import { createAuthClient } from "better-auth/react";
import { localSession } from "./local-workbench";

export const authClient: ReactAuthClient<{
  // An uninstantiated generic resolves to `any`, which would erase every plugin's actions.
  plugins: [
    ReturnType<typeof organizationClient<OrganizationClientOptions>>,
    ReturnType<typeof emailOTPClient>,
    ReturnType<typeof passkeyClient>,
  ];
}> = createAuthClient({
  plugins: [organizationClient(), emailOTPClient(), passkeyClient()],
});

// The desktop build runs against the local service, which authenticated the page
// with its own token; there is no Better Auth server to ask for a session.
const betterAuthUseSession = authClient.useSession.bind(authClient);
authClient.useSession = ((...args: Parameters<typeof betterAuthUseSession>) => {
  const local = localSession();
  const remote = betterAuthUseSession(...args);
  if (!local) return remote;
  return {
    ...remote,
    data: local as unknown as typeof remote.data,
    error: null,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: local, error: null } as never),
  };
}) as typeof authClient.useSession;
