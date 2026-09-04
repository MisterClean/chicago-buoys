export type QualityState =
  | "good"
  | "not_evaluated"
  | "suspect"
  | "bad"
  | "missing";

export type ObservationValues = {
  airPressureHpa?: number;
  airTemperatureC?: number;
  batteryVoltage?: number;
  dewPointTemperatureC?: number;
  relativeHumidityPercent?: number;
  seaSurfaceTemperatureC?: number;
  significantWaveHeightM?: number;
  maximumWaveHeightM?: number;
  waveFromDirectionDeg?: number;
  waveMeanPeriodS?: number;
  windFromDirectionDeg?: number;
  windGustMps?: number;
  windSpeedMps?: number;
};

export type TemperaturePoint = {
  depthM: number;
  quality: QualityState;
  temperatureC: number;
};

export type NormalizedObservation = {
  stationKey: string;
  observedAt: string;
  ingestedAt: string;
  source: string;
  sourceDataset: string;
  sourceHash: string;
  overallQuality: QualityState;
  values: ObservationValues;
  fieldQuality: Record<string, QualityState>;
  profile: TemperaturePoint[];
  missingFields: string[];
  raw: unknown;
};

export type SourceFetchResult = {
  observations: NormalizedObservation[];
  source: string;
  warnings: string[];
};

export interface ObservationSource {
  readonly id: string;
  fetchRecent(stationKey: string, since: Date): Promise<SourceFetchResult>;
}

export type MediaAttachment =
  | {
      kind: "image";
      alt: string;
      bytes: Uint8Array;
      mimeType: string;
      aspectRatio?: { width: number; height: number };
    }
  | {
      kind: "video";
      alt: string;
      bytes: Uint8Array;
      mimeType: "video/mp4";
      aspectRatio?: { width: number; height: number };
    };

export type CanonicalPost = {
  idempotencyKey: string;
  kind: string;
  stationKey: string;
  text: string;
  langs: string[];
  observedAt: string;
  sourceUrls: string[];
  links?: Array<{
    label: string;
    uri: string;
  }>;
  media?: MediaAttachment;
};

export type PublishReceipt = {
  publisherId: string;
  uri: string;
  cid: string;
  publishedAt: string;
};

export interface Publisher {
  readonly id: string;
  publish(post: CanonicalPost): Promise<PublishReceipt>;
}
