import { DeviceInfo } from "./api";
import HardwareBadge from "./HardwareBadge";

/**
 * A slim bar fixed to the bottom of the window: what is being worked on (camera › product › ROI) on the left,
 * the device the neural parts run on and the app version on the right.
 */
export default function StatusBar({
  camera,
  product,
  feature,
  info,
  device,
}: {
  camera: string;
  product: string;
  feature: string;
  info: { version: string; released: string } | null;
  device: DeviceInfo | null;
}) {
  const crumbs = [camera, product, feature && feature.split("::").pop()].filter(Boolean) as string[];
  return (
    <footer className="statusbar" aria-label="Status">
      <span className="statusbar-where" data-testid="status-where">
        {crumbs.length ? crumbs.join(" › ") : "No camera"}
      </span>
      <span className="statusbar-right">
        {device && <HardwareBadge info={device} />}
        {info && (
          <span className="app-version" title="Application version and release date">
            v{info.version} · {info.released}
          </span>
        )}
      </span>
    </footer>
  );
}
