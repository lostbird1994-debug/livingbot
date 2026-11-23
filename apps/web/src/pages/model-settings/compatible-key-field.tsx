import { Trans } from "@lingui/react/macro";
import { isOllamaCloudBaseUrl } from "@livingbot/contracts";
import { Disclosure } from "@livingbot/ui-web";
import type { ReactNode } from "react";

export function CompatibleKeyField({
  baseUrl,
  defaultOpen = false,
  className,
  children,
}: {
  baseUrl: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return isOllamaCloudBaseUrl(baseUrl) ? (
    <div className={className}>
      <span>
        <Trans>API key</Trans>
      </span>
      {children}
    </div>
  ) : (
    <Disclosure defaultOpen={defaultOpen} className={className} summary={<Trans>API key</Trans>}>
      {children}
    </Disclosure>
  );
}
