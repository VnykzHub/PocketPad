// Composition root: load and validate the shared layout, then hand the page to
// the PlayCanvas view. The scene loop owns readiness (first rendered frame).
import { createScene } from './view.js';
import { normalizeLayout } from './sim.js';

async function loadLayout() {
    const response = await fetch('../assets/layout.json', { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`layout.json: HTTP ${response.status}`);
    }
    return normalizeLayout(await response.json());
}

async function main() {
    const contract = window.__BAKEOFF__;
    try {
        const layout = await loadLayout();
        await createScene({
            canvas: document.getElementById('app'),
            layout,
            contract
        });
    } catch (error) {
        window.__pushBakeoffError(error);
        const hud = document.getElementById('hud');
        if (hud) {
            hud.textContent = `PlayCanvas bake-off — failed: ${error.message}`;
        }
    }
}

main();
