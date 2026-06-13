import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

type WeightUnit = "GRAMS" | "KILOGRAMS" | "OUNCES" | "POUNDS";

type VariantSummary = {
  id: string;
  productId: string;
  productTitle: string;
  productHandle: string;
  vendor: string;
  variantTitle: string;
  sku: string;
  barcode: string;
  selectedOptions: Array<{ name: string; value: string }>;
  weight: {
    value: number | null;
    unit: WeightUnit | null;
  };
};

type LookupActionData = {
  intent: "lookup";
  ok: boolean;
  barcode: string;
  matches: number;
  message: string;
  variant: VariantSummary | null;
};

type SaveActionData = {
  intent: "save";
  ok: boolean;
  message: string;
  variant: VariantSummary | null;
};

type ActionData = LookupActionData | SaveActionData;

type DetectedBarcode = {
  rawValue?: string;
};

type BarcodeDetectorClass = {
  new (options?: { formats?: string[] }): {
    detect: (source: ImageBitmapSource) => Promise<DetectedBarcode[]>;
  };
  getSupportedFormats?: () => Promise<string[]>;
};

type VariantNode = {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  product: {
    id: string;
    title: string;
    handle: string;
    vendor: string | null;
  };
  selectedOptions: Array<{
    name: string;
    value: string;
  }>;
  inventoryItem: {
    measurement: {
      weight: {
        value: number;
        unit: WeightUnit;
      } | null;
    } | null;
  } | null;
};

const lookupQuery = `#graphql
  query WeightEntryLookup($query: String!) {
    productVariants(first: 10, query: $query) {
      nodes {
        id
        title
        sku
        barcode
        product {
          id
          title
          handle
          vendor
        }
        selectedOptions {
          name
          value
        }
        inventoryItem {
          measurement {
            weight {
              unit
              value
            }
          }
        }
      }
    }
  }
`;

const saveMutation = `#graphql
  mutation WeightEntrySave(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        title
        sku
        barcode
        product {
          id
          title
          handle
          vendor
        }
        selectedOptions {
          name
          value
        }
        inventoryItem {
          measurement {
            weight {
              unit
              value
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const unitOptions: Array<{ label: string; value: WeightUnit }> = [
  { label: "Grams", value: "GRAMS" },
  { label: "Kilograms", value: "KILOGRAMS" },
  { label: "Ounces", value: "OUNCES" },
  { label: "Pounds", value: "POUNDS" },
];

function normalizeBarcode(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function escapeSearchValue(value: string) {
  return value.replace(/[\\"]/g, "\\$&");
}

function mapVariant(node: VariantNode): VariantSummary {
  return {
    id: node.id,
    productId: node.product.id,
    productTitle: node.product.title,
    productHandle: node.product.handle,
    vendor: node.product.vendor ?? "",
    variantTitle: node.title,
    sku: node.sku ?? "",
    barcode: node.barcode ?? "",
    selectedOptions: node.selectedOptions,
    weight: {
      value: node.inventoryItem?.measurement?.weight?.value ?? null,
      unit: node.inventoryItem?.measurement?.weight?.unit ?? null,
    },
  };
}

function getVariantLabel(variant: VariantSummary) {
  return variant.variantTitle === "Default Title"
    ? variant.productTitle
    : `${variant.productTitle} - ${variant.variantTitle}`;
}

function getBarcodeDetector() {
  if (typeof window === "undefined") {
    return null;
  }

  const detector = (window as Window & {
    BarcodeDetector?: BarcodeDetectorClass;
  }).BarcodeDetector;

  return detector ?? null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "lookup") {
    const barcode = String(formData.get("barcode") ?? "").trim();

    if (!barcode) {
      return {
        intent: "lookup",
        ok: false,
        barcode: "",
        matches: 0,
        message: "Scan or enter a barcode before searching.",
        variant: null,
      } satisfies LookupActionData;
    }

    const response = await admin.graphql(lookupQuery, {
      variables: {
        query: `barcode:\"${escapeSearchValue(barcode)}\"`,
      },
    });

    const responseJson = (await response.json()) as {
      data?: {
        productVariants?: {
          nodes?: VariantNode[];
        };
      };
    };

    const nodes = responseJson.data?.productVariants?.nodes ?? [];
    const normalizedBarcode = normalizeBarcode(barcode);
    const exactMatches = nodes.filter(
      (node) => normalizeBarcode(node.barcode ?? "") === normalizedBarcode,
    );
    const selectedNode = exactMatches[0] ?? nodes[0] ?? null;

    if (!selectedNode) {
      return {
        intent: "lookup",
        ok: false,
        barcode,
        matches: 0,
        message: `No Shopify variant matched barcode ${barcode}.`,
        variant: null,
      } satisfies LookupActionData;
    }

    const selectedVariant = mapVariant(selectedNode);
    const message =
      exactMatches.length > 1 || nodes.length > 1
        ? `Found ${nodes.length} matches for ${barcode}. Showing the first exact barcode match.`
        : `Loaded ${getVariantLabel(selectedVariant)}.`;

    return {
      intent: "lookup",
      ok: true,
      barcode,
      matches: nodes.length,
      message,
      variant: selectedVariant,
    } satisfies LookupActionData;
  }

  if (intent === "save") {
    const productId = String(formData.get("productId") ?? "");
    const variantId = String(formData.get("variantId") ?? "");
    const barcode = String(formData.get("barcode") ?? "").trim();
    const weightValueRaw = String(formData.get("weightValue") ?? "").trim();
    const unit = String(formData.get("weightUnit") ?? "") as WeightUnit;
    const weightValue = Number(weightValueRaw);

    if (!productId || !variantId || !barcode) {
      return {
        intent: "save",
        ok: false,
        message: "Search for a product before saving a weight.",
        variant: null,
      } satisfies SaveActionData;
    }

    if (!Number.isFinite(weightValue) || weightValue <= 0) {
      return {
        intent: "save",
        ok: false,
        message: "Enter a weight greater than zero.",
        variant: null,
      } satisfies SaveActionData;
    }

    if (!unitOptions.some((option) => option.value === unit)) {
      return {
        intent: "save",
        ok: false,
        message: "Choose a valid weight unit.",
        variant: null,
      } satisfies SaveActionData;
    }

    const response = await admin.graphql(saveMutation, {
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            inventoryItem: {
              measurement: {
                weight: {
                  unit,
                  value: weightValue,
                },
              },
            },
          },
        ],
      },
    });

    const responseJson = (await response.json()) as {
      data?: {
        productVariantsBulkUpdate?: {
          productVariants?: VariantNode[];
          userErrors?: Array<{
            field?: string[];
            message: string;
          }>;
        };
      };
    };

    const userErrors =
      responseJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return {
        intent: "save",
        ok: false,
        message: userErrors.map((error) => error.message).join(" "),
        variant: null,
      } satisfies SaveActionData;
    }

    const updatedNode =
      responseJson.data?.productVariantsBulkUpdate?.productVariants?.[0] ?? null;

    if (!updatedNode) {
      return {
        intent: "save",
        ok: false,
        message: "Shopify did not return the updated variant.",
        variant: null,
      } satisfies SaveActionData;
    }

    const updatedVariant = mapVariant(updatedNode);

    return {
      intent: "save",
      ok: true,
      message: `Saved ${weightValue} ${unit.toLowerCase()} for ${getVariantLabel(updatedVariant)}.`,
      variant: updatedVariant,
    } satisfies SaveActionData;
  }

  return {
    intent: "lookup",
    ok: false,
    barcode: "",
    matches: 0,
    message: "Unknown action requested.",
    variant: null,
  } satisfies LookupActionData;
};

export default function Index() {
  const lookupFetcher = useFetcher<ActionData>();
  const saveFetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<InstanceType<BarcodeDetectorClass> | null>(null);
  const scanTimeoutRef = useRef<number | null>(null);
  const [barcode, setBarcode] = useState("");
  const [weightValue, setWeightValue] = useState("");
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("GRAMS");
  const [selectedVariant, setSelectedVariant] = useState<VariantSummary | null>(
    null,
  );
  const [cameraState, setCameraState] = useState<
    "idle" | "starting" | "scanning"
  >("idle");
  const [cameraMessage, setCameraMessage] = useState(
    "Use your phone camera to scan a barcode when the browser supports live barcode detection.",
  );

  const isLookupLoading =
    ["loading", "submitting"].includes(lookupFetcher.state) &&
    lookupFetcher.formMethod === "POST";
  const isSaveLoading =
    ["loading", "submitting"].includes(saveFetcher.state) &&
    saveFetcher.formMethod === "POST";

  const stopCamera = () => {
    if (scanTimeoutRef.current != null) {
      window.clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    setCameraState("idle");
  };

  const submitLookup = (scannedBarcode: string) => {
    const normalized = normalizeBarcode(scannedBarcode);
    setBarcode(normalized);
    lookupFetcher.submit(
      { intent: "lookup", barcode: normalized },
      { method: "post" },
    );
  };

  const scheduleScan = () => {
    scanTimeoutRef.current = window.setTimeout(async () => {
      if (
        !videoRef.current ||
        !detectorRef.current ||
        videoRef.current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        scheduleScan();
        return;
      }

      try {
        const barcodes = await detectorRef.current.detect(videoRef.current);
        const firstMatch = barcodes.find((entry) => entry.rawValue?.trim());

        if (firstMatch?.rawValue) {
          setCameraMessage(`Scanned ${firstMatch.rawValue}. Looking up product...`);
          stopCamera();
          submitLookup(firstMatch.rawValue);
          return;
        }
      } catch {
        setCameraMessage(
          "Camera is active, but barcode decoding failed. Try moving closer or improving lighting.",
        );
      }

      scheduleScan();
    }, 350);
  };

  const startCamera = async () => {
    const BarcodeDetector = getBarcodeDetector();

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraMessage(
        "This browser does not allow camera access here. Use manual entry or a hardware scanner.",
      );
      return;
    }

    if (!BarcodeDetector) {
      setCameraMessage(
        "This browser does not support live barcode detection. Use manual entry or a hardware scanner.",
      );
      return;
    }

    try {
      setCameraState("starting");
      setCameraMessage("Opening camera...");

      const supportedFormats = BarcodeDetector.getSupportedFormats
        ? await BarcodeDetector.getSupportedFormats()
        : [];
      const formats = supportedFormats.length
        ? supportedFormats.filter((format) =>
            [
              "ean_13",
              "ean_8",
              "upc_a",
              "upc_e",
              "code_128",
              "code_39",
              "qr_code",
            ].includes(format),
          )
        : undefined;

      detectorRef.current = new BarcodeDetector(
        formats && formats.length > 0 ? { formats } : undefined,
      );

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
        },
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setCameraState("scanning");
      setCameraMessage("Point the camera at a barcode.");
      scheduleScan();
    } catch {
      stopCamera();
      setCameraMessage(
        "Unable to start the camera. Check camera permission in the browser and try again.",
      );
    }
  };

  useEffect(() => {
    if (lookupFetcher.data?.intent !== "lookup") {
      return;
    }

    setSelectedVariant(lookupFetcher.data.variant);
    if (lookupFetcher.data.variant?.weight.value != null) {
      setWeightValue(String(lookupFetcher.data.variant.weight.value));
    } else {
      setWeightValue("");
    }
    if (lookupFetcher.data.variant?.weight.unit) {
      setWeightUnit(lookupFetcher.data.variant.weight.unit);
    }

    shopify.toast.show(lookupFetcher.data.message);
  }, [lookupFetcher.data, shopify]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  useEffect(() => {
    if (saveFetcher.data?.intent !== "save") {
      return;
    }

    if (saveFetcher.data.variant) {
      setSelectedVariant(saveFetcher.data.variant);
      if (saveFetcher.data.variant.weight.value != null) {
        setWeightValue(String(saveFetcher.data.variant.weight.value));
      }
      if (saveFetcher.data.variant.weight.unit) {
        setWeightUnit(saveFetcher.data.variant.weight.unit);
      }
    }

    shopify.toast.show(saveFetcher.data.message);
  }, [saveFetcher.data, shopify]);

  const lookupMessage =
    lookupFetcher.data?.intent === "lookup" ? lookupFetcher.data.message : "";
  const saveMessage =
    saveFetcher.data?.intent === "save" ? saveFetcher.data.message : "";
  const variantLabel = selectedVariant ? getVariantLabel(selectedVariant) : "";
  const variantOptions = selectedVariant?.selectedOptions.filter(
    (option) => option.value && option.value !== "Default Title",
  );

  const formCardStyle = {
    display: "grid",
    gap: "0.75rem",
    maxWidth: "32rem",
  } as const;

  const fieldStyle = {
    display: "grid",
    gap: "0.35rem",
  } as const;

  const inputStyle = {
    width: "100%",
    padding: "0.7rem 0.8rem",
    border: "1px solid #8a8a8a",
    borderRadius: "0.5rem",
    fontSize: "1rem",
  } as const;

  const buttonStyle = {
    padding: "0.75rem 1rem",
    borderRadius: "0.5rem",
    border: "none",
    background: "#111827",
    color: "#ffffff",
    fontSize: "0.95rem",
    fontWeight: 600,
    cursor: "pointer",
  } as const;

  const secondaryButtonStyle = {
    ...buttonStyle,
    background: selectedVariant ? "#111827" : "#9ca3af",
  };

  const cameraButtonStyle = {
    ...buttonStyle,
    background: cameraState === "scanning" ? "#991b1b" : "#14532d",
  };

  const videoStyle = {
    width: "100%",
    maxWidth: "32rem",
    borderRadius: "0.75rem",
    border: "1px solid #8a8a8a",
    background: "#111827",
    aspectRatio: "3 / 4",
    objectFit: "cover",
  } as const;

  return (
    <s-page heading="Weight Entry">
      <s-section heading="Scan a barcode">
        <s-paragraph>
          Scan with a USB or Bluetooth barcode scanner, or type the barcode by
          hand. The app looks up the matching Shopify variant and loads its
          current shipping weight.
        </s-paragraph>
        <lookupFetcher.Form method="post" style={formCardStyle}>
          <input type="hidden" name="intent" value="lookup" />
          <label style={fieldStyle}>
            <span style={{ fontWeight: 600 }}>Barcode</span>
            <input
              autoFocus
              autoComplete="off"
              inputMode="numeric"
              name="barcode"
              onChange={(event) => setBarcode(event.currentTarget.value)}
              placeholder="Scan barcode"
              style={inputStyle}
              value={barcode}
            />
          </label>
          <button disabled={isLookupLoading} style={buttonStyle} type="submit">
            {isLookupLoading ? "Searching..." : "Find product"}
          </button>
        </lookupFetcher.Form>
        {lookupMessage ? (
          <s-paragraph>{lookupMessage}</s-paragraph>
        ) : null}

        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <div style={{ display: "grid", gap: "0.75rem", maxWidth: "32rem" }}>
            <strong>Mobile camera scanner</strong>
            <video muted playsInline ref={videoRef} style={videoStyle} />
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <button
                disabled={cameraState === "starting"}
                onClick={() => {
                  if (cameraState === "scanning") {
                    stopCamera();
                    setCameraMessage("Camera stopped.");
                    return;
                  }

                  void startCamera();
                }}
                style={cameraButtonStyle}
                type="button"
              >
                {cameraState === "starting"
                  ? "Opening camera..."
                  : cameraState === "scanning"
                    ? "Stop camera"
                    : "Scan with camera"}
              </button>
            </div>
            <span>{cameraMessage}</span>
          </div>
        </s-box>
      </s-section>

      <s-section heading="Update shipping weight">
        <s-paragraph>
          Once a variant is loaded, enter the measured weight and save it back
          to Shopify. This updates the variant&apos;s inventory item weight used
          for shipping calculations.
        </s-paragraph>
        {selectedVariant ? (
          <s-stack direction="block" gap="base">
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <strong>{variantLabel}</strong>
                <span>Vendor: {selectedVariant.vendor || "Unknown"}</span>
                <span>SKU: {selectedVariant.sku || "Not set"}</span>
                <span>Barcode: {selectedVariant.barcode}</span>
                <span>
                  Current weight:{" "}
                  {selectedVariant.weight.value != null &&
                  selectedVariant.weight.unit
                    ? `${selectedVariant.weight.value} ${selectedVariant.weight.unit.toLowerCase()}`
                    : "Not set"}
                </span>
                {variantOptions && variantOptions.length > 0 ? (
                  <span>
                    Options:{" "}
                    {variantOptions
                      .map((option) => `${option.name}: ${option.value}`)
                      .join(", ")}
                  </span>
                ) : null}
              </div>
            </s-box>

            <saveFetcher.Form method="post" style={formCardStyle}>
              <input type="hidden" name="intent" value="save" />
              <input name="productId" type="hidden" value={selectedVariant.productId} />
              <input name="variantId" type="hidden" value={selectedVariant.id} />
              <input name="barcode" type="hidden" value={selectedVariant.barcode} />

              <label style={fieldStyle}>
                <span style={{ fontWeight: 600 }}>Weight</span>
                <input
                  inputMode="decimal"
                  min="0"
                  name="weightValue"
                  onChange={(event) => setWeightValue(event.currentTarget.value)}
                  placeholder="0.00"
                  step="0.01"
                  style={inputStyle}
                  type="number"
                  value={weightValue}
                />
              </label>

              <label style={fieldStyle}>
                <span style={{ fontWeight: 600 }}>Unit</span>
                <select
                  name="weightUnit"
                  onChange={(event) =>
                    setWeightUnit(event.currentTarget.value as WeightUnit)
                  }
                  style={inputStyle}
                  value={weightUnit}
                >
                  {unitOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <button
                disabled={isSaveLoading}
                style={secondaryButtonStyle}
                type="submit"
              >
                {isSaveLoading ? "Saving..." : "Save weight"}
              </button>
            </saveFetcher.Form>
            {saveMessage ? <s-paragraph>{saveMessage}</s-paragraph> : null}
          </s-stack>
        ) : (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-paragraph>
              No product is loaded yet. Scan a barcode to start weighing items.
            </s-paragraph>
          </s-box>
        )}
      </s-section>

      <s-section slot="aside" heading="Workflow notes">
        <s-unordered-list>
          <s-list-item>Barcode lookup uses Shopify variant barcodes.</s-list-item>
          <s-list-item>
            Weight saves through the Admin GraphQL API.
          </s-list-item>
          <s-list-item>
            A hardware scanner usually works faster than camera scanning.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Next build steps">
        <s-unordered-list>
          <s-list-item>Filter to only variants with missing weights.</s-list-item>
          <s-list-item>Log recent updates for auditing.</s-list-item>
          <s-list-item>Support store switching outside the dev store.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
