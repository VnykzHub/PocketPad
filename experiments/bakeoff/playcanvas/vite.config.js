import { defineConfig } from 'vite';

// Relative base: the runner serves the page at /experiments/bakeoff/playcanvas/
// and every emitted chunk must resolve beneath that path.
export default defineConfig({
    base: './',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: false
    },
    server: {
        // The shared assets live one level above this package during `vite dev`.
        fs: { allow: ['..'] },
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'same-origin'
        }
    }
});
