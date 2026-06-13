import { useEffect, useMemo, useRef, useState } from "react";
import type { Html5Qrcode as Html5QrcodeScanner } from "html5-qrcode";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useSearchParams } from "react-router";

function normalizeBarcode(value: string) {
  return value.replace(/\s+/g, "").trim();
}

export default function ScanPage() {
  const [searchParams] = useSearchParams();
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);
  const lastScannedRef = useRef("");
  const [cameraState, setCameraState] = useState<
    "idle" | "starting" | "scanning" | "complete"
  >("idle");
  const [cameraMessage, setCameraMessage] = useState(
    "Use your phone camera outside the Shopify iframe to scan a barcode.",
  );
  const [scannedBarcode, setScannedBarcode] = useState("");

  const shopParam = searchParams.get("shop") ?? "";
  const returnTo = searchParams.get("returnTo") ?? "/app";
  const continueUrl = useMemo(() => {
    const destination = new URL(returnTo, window.location.origin);

    if (shopParam) {
      destination.searchParams.set("shop", shopParam);
    }

    if (scannedBarcode) {
      destination.searchParams.set("barcode", scannedBarcode);
    }

    return destination.pathname + destination.search;
  }, [returnTo, scannedBarcode, shopParam]);

  const stopCamera = async () => {
    const scanner = scannerRef.current;

    if (scanner) {
      try {
        if (scanner.isScanning) {
          await scanner.stop();
        }
      } catch {
        // Ignore scanner stop errors.
      }

      try {
        scanner.clear();
      } catch {
        // Ignore cleanup errors after partial start.
      }

      scannerRef.current = null;
    }
  };

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraMessage(
        "This browser does not allow camera access here. Use a hardware scanner instead.",
      );
      return;
    }

    try {
      setCameraState("starting");
      setCameraMessage("Opening camera...");
      lastScannedRef.current = "";
      await stopCamera();

      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import(
        "html5-qrcode"
      );

      const scanner = new Html5Qrcode("standalone-scanner-region", {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
        ],
        useBarCodeDetectorIfSupported: true,
        verbose: false,
      });

      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 280, height: 160 },
          disableFlip: false,
          aspectRatio: 1.333334,
        },
        async (decodedText) => {
          const normalizedBarcode = normalizeBarcode(decodedText);
          if (
            !normalizedBarcode ||
            normalizedBarcode === lastScannedRef.current
          ) {
            return;
          }

          lastScannedRef.current = normalizedBarcode;
          setScannedBarcode(normalizedBarcode);
          setCameraState("complete");
          setCameraMessage(
            `Scanned ${normalizedBarcode}. Continue back to weight entry.`,
          );
          await stopCamera();
        },
        () => {
          // Ignore per-frame decode misses while camera is active.
        },
      );

      setCameraState("scanning");
      setCameraMessage("Point the camera at a barcode.");
    } catch {
      await stopCamera();
      setCameraState("idle");
      setCameraMessage(
        "Unable to start the camera. Check browser camera permission, then try again.",
      );
    }
  };

  useEffect(() => {
    return () => {
      void stopCamera();
    };
  }, []);

  const buttonStyle = {
    padding: "0.85rem 1rem",
    borderRadius: "0.6rem",
    border: "none",
    background: "#111827",
    color: "#ffffff",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
  } as const;

  const scannerRegionStyle = {
    width: "100%",
    maxWidth: "32rem",
    borderRadius: "0.75rem",
    border: "1px solid #8a8a8a",
    background: "#111827",
    aspectRatio: "3 / 4",
    overflow: "hidden",
  } as const;

  return (
    <AppProvider embedded={false}>
      <s-page heading="Standalone barcode scanner">
        <s-section heading="Scan outside Shopify admin">
          <s-paragraph>
            This page runs outside the embedded Shopify admin iframe so your
            phone browser can request camera access directly.
          </s-paragraph>
          <div style={{ display: "grid", gap: "0.75rem", maxWidth: "32rem" }}>
            <div id="standalone-scanner-region" style={scannerRegionStyle} />
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <button
                disabled={cameraState === "starting"}
                onClick={() => {
                  if (cameraState === "scanning") {
                    void stopCamera().then(() => setCameraState("idle"));
                    setCameraMessage("Camera stopped.");
                    return;
                  }

                  void startCamera();
                }}
                style={{
                  ...buttonStyle,
                  background: cameraState === "scanning" ? "#991b1b" : "#14532d",
                }}
                type="button"
              >
                {cameraState === "starting"
                  ? "Opening camera..."
                  : cameraState === "scanning"
                    ? "Stop camera"
                    : "Scan with camera"}
              </button>

              {scannedBarcode ? (
                <a href={continueUrl} style={{ textDecoration: "none" }}>
                  <button style={buttonStyle} type="button">
                    Continue to weight entry
                  </button>
                </a>
              ) : null}
            </div>
            <span>{cameraMessage}</span>
            {scannedBarcode ? (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-paragraph>Scanned barcode: {scannedBarcode}</s-paragraph>
              </s-box>
            ) : null}
          </div>
        </s-section>
      </s-page>
    </AppProvider>
  );
}