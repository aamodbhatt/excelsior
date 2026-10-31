/// <reference lib="webworker" />
import { type EngineEnvelope, EngineHost } from '@excelsior/engine';

// The whole calculation engine lives off the main thread; the UI only sees values of visible ranges.
const host = new EngineHost((msg) => self.postMessage(msg));
self.onmessage = (e: MessageEvent<EngineEnvelope>) => host.handle(e.data);
