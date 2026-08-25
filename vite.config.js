import { defineConfig } from 'vite';

/* Two things get built:
   - `npm run build`      the Webflow embed: one self-contained IIFE with
                          OGL bundled in, for a single <script src>.
   - `npm run build:site` the demo pages, for previewing the bundle. */
export default defineConfig(({ mode }) => {
  if (mode === 'site') {
    return {
      build: {
        outDir: 'dist-site',
        rollupOptions: {
          input: { main: 'index.html', webflow: 'webflow.html' },
        },
      },
    };
  }

  return {
    build: {
      target: 'es2018',
      lib: {
        entry: 'src/embed.js',
        name: 'MwSlider',
        formats: ['iife'],
        fileName: () => 'mw-slider.js',
      },
      // one file, nothing to fetch afterwards
      cssCodeSplit: false,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  };
});
