import { useStream } from "../api/stream";
import { useApi } from "../app/context";
import { showError } from "../app/errorStore";
import { usePendingValue } from "../app/hooks";
import { useI18n } from "../app/i18n";
import { Icon } from "./Icon";
import { Spinner, Switch } from "./ui";

// Tailscale force relay is process-wide: the switch applies to every
// Tailscale endpoint of the core and is kept in its cache file.
export function ForceRelayRow() {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.extended.forceRelay);
  const [enabled, setPending, applying] = usePendingValue(status.data.enabled);
  return (
    <div className="settings-row">
      <Icon name="relay" size={16} />
      <div className="settings-row-text">
        <span className="settings-row-label">{t("Force DERP relay")}</span>
        <span className="hint">
          {t("Reach every peer only through DERP relays, for all Tailscale endpoints. Kept across restarts.")}
        </span>
      </div>
      {applying && <Spinner />}
      <Switch
        label={t("Force DERP relay")}
        value={enabled}
        disabled={!status.data.loaded || applying}
        onChange={(value) => {
          setPending(value);
          api.extended.setForceRelay(value).catch((error: unknown) => {
            setPending(null);
            showError(error);
          });
        }}
      />
    </div>
  );
}
