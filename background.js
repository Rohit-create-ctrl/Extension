// MV3 service workers are ephemeral, so all listeners are registered at module load.
// No browsing state is kept in memory; tracker.js always rehydrates from storage.
import './tracker.js';
