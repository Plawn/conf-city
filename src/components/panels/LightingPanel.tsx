import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import {
  computeSolarState,
  PARIS,
  parseLocalPreview,
  resolveSolarInstant,
} from "../../domain/solar";
import { useLightingStore } from "../../store/lightingStore";
import { Button, Input } from "../ui";

export function LightingPanel() {
  const { location, clock, setLocation, preview, live } = useLightingStore();
  const [now, setNow] = useState(Date.now);
  const [lat, setLat] = useState(String(location.latitude));
  const [lon, setLon] = useState(String(location.longitude));
  const [zone, setZone] = useState(location.timeZone);
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) {
        setNow(Date.now());
      }
    };
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const solar = computeSolarState(resolveSolarInstant(clock, now), location);
  const local = DateTime.fromMillis(solar.instantUtcMs, { zone: location.timeZone });
  const formatTime = (time: number | null) =>
    time == null ? "—" : DateTime.fromMillis(time, { zone: location.timeZone }).toFormat("HH:mm");
  return (
    <details className="text-[11px] text-surface-300">
      <summary className="heading cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-accent-400">
        Sun & lighting{" "}
        <span className="font-normal">
          · {local.toFormat("HH:mm")}
          {clock.mode === "preview" ? " · Preview" : ""}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p>
          {local.toFormat("dd LLL yyyy · HH:mm ZZ")} · {location.timeZone}
        </p>
        <p>
          {solar.polar
            ? `Polar ${solar.polar} · no sunrise/sunset`
            : `Sunrise ${formatTime(solar.sunrise)} · sunset ${formatTime(solar.sunset)}`}
        </p>
        <p>Sun {solar.altitude.toFixed(1)}° above horizon · N → E → S → W</p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              if (!lat.trim() || !lon.trim()) {
                throw new Error("Enter latitude and longitude.");
              }
              setLocation({ latitude: Number(lat), longitude: Number(lon), timeZone: zone.trim() });
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label htmlFor="solar-lat">
            Latitude
            <Input
              id="solar-lat"
              aria-label="Latitude"
              type="number"
              min="-90"
              max="90"
              step="any"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              required
            />
          </label>
          <label htmlFor="solar-lon">
            Longitude
            <Input
              id="solar-lon"
              aria-label="Longitude"
              type="number"
              min="-180"
              max="180"
              step="any"
              value={lon}
              onChange={(e) => setLon(e.target.value)}
              required
            />
          </label>
          <label htmlFor="solar-zone">
            Time zone
            <Input
              id="solar-zone"
              aria-label="Time zone"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Europe/Paris"
              required
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit">Apply location</Button>
            <Button
              onClick={() => {
                setLocation(PARIS);
                setLat(String(PARIS.latitude));
                setLon(String(PARIS.longitude));
                setZone(PARIS.timeZone);
                setError("");
              }}
            >
              Paris
            </Button>
          </div>
        </form>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              preview(parseLocalPreview(date, location.timeZone));
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label htmlFor="solar-preview">
            Preview local date & time
            <Input
              id="solar-preview"
              aria-label="Preview local date & time"
              type="datetime-local"
              step="60"
              value={date}
              onFocus={() => {
                if (!date) {
                  setDate(local.toFormat("yyyy-MM-dd'T'HH:mm"));
                }
              }}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit">Preview</Button>
            <Button
              onClick={() => {
                live();
                setError("");
              }}
            >
              Live now
            </Button>
          </div>
        </form>
        {clock.mode === "preview" && (
          <p>
            Lighting preview only; live traffic and telemetry continue. Repeated clock times use the
            first occurrence.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
