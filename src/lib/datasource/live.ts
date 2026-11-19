import { FirebaseDataSource } from "./firebase";
import {
  NotConnectedError,
  type DataSource,
  type GetLatestOptions,
  type LatestSnapshot,
} from "./interface";

/**
 * Stub implementation for Live Mode (ESP32 -> Firebase).
 * Inherits and re-exports FirebaseDataSource behavior, explicitly throwing
 * NotConnectedError so the UI displays "Awaiting connection" until real sensor
 * hardware is provisioned.
 */
export class LiveDataSource extends FirebaseDataSource {}
