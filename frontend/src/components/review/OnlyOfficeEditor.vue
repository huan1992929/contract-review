<template>
  <div ref="host" class="onlyoffice-editor-host" />
</template>

<script>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

let docsApiLoadPromise = null;

const normalizeBaseUrl = (url) => `${String(url || '').replace(/\/+$/, '')}/`;

const loadDocsApi = (documentServerUrl) => {
  if (window.DocsAPI?.DocEditor) return Promise.resolve(window.DocsAPI);
  if (docsApiLoadPromise) return docsApiLoadPromise;

  docsApiLoadPromise = new Promise((resolve, reject) => {
    const scriptId = 'onlyoffice-api-script';
    const docsApiUrl = `${normalizeBaseUrl(documentServerUrl)}web-apps/apps/api/documents/api.js`;
    let script = document.getElementById(scriptId);

    const handleLoad = () => {
      if (window.DocsAPI?.DocEditor) resolve(window.DocsAPI);
      else reject(new Error('ONLYOFFICE_DOCS_API_UNAVAILABLE'));
    };
    const handleError = () => {
      docsApiLoadPromise = null;
      reject(new Error(`ONLYOFFICE_DOCS_API_LOAD_FAILED:${docsApiUrl}`));
    };

    if (script) {
      script.addEventListener('load', handleLoad, { once: true });
      script.addEventListener('error', handleError, { once: true });
      window.setTimeout(() => {
        if (window.DocsAPI?.DocEditor) resolve(window.DocsAPI);
      }, 0);
      return;
    }

    script = document.createElement('script');
    script.id = scriptId;
    script.src = docsApiUrl;
    script.async = true;
    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });
    document.head.appendChild(script);
  });

  return docsApiLoadPromise;
};

const cloneConfig = (config) => JSON.parse(JSON.stringify(config || {}));

export default {
  name: 'OnlyOfficeEditor',
  props: {
    id: { type: String, required: true },
    documentServerUrl: { type: String, required: true },
    config: { type: Object, required: true },
    onDocumentReady: { type: Function, default: null },
    onDocumentStateChange: { type: Function, default: null },
    onError: { type: Function, default: null },
  },
  setup(props, { expose }) {
    const host = ref(null);
    const editorInstance = ref(null);
    let generation = 0;
    let disposed = false;

    const unregisterEditor = (instance) => {
      if (!window.DocEditor?.instances) return;
      if (window.DocEditor.instances[props.id] === instance) {
        delete window.DocEditor.instances[props.id];
      }
    };

    const destroyEditor = () => {
      const instance = editorInstance.value;
      editorInstance.value = null;
      if (instance) {
        try {
          instance.destroyEditor?.();
        } catch (error) {
          console.warn('[OnlyOffice] editor destroy failed', error);
        }
        unregisterEditor(instance);
      }
      // Vue owns only the outer host. ONLYOFFICE may replace or remove its
      // target node, so all inner DOM cleanup stays inside this component.
      host.value?.replaceChildren();
    };

    const buildEditor = async (config) => {
      const currentGeneration = ++generation;
      destroyEditor();
      await nextTick();

      try {
        await loadDocsApi(props.documentServerUrl);
        if (disposed || currentGeneration !== generation || !host.value) return;

        const target = document.createElement('div');
        target.id = props.id;
        target.className = 'onlyoffice-editor-target';
        host.value.replaceChildren(target);

        const editorConfig = cloneConfig(config);
        const configuredEvents = editorConfig.events || {};
        editorConfig.events = {
          ...configuredEvents,
          onDocumentReady: (event) => {
            if (disposed || currentGeneration !== generation) return;
            props.onDocumentReady?.(event);
            configuredEvents.onDocumentReady?.(event);
          },
          onDocumentStateChange: (event) => {
            if (disposed || currentGeneration !== generation) return;
            props.onDocumentStateChange?.(event);
            configuredEvents.onDocumentStateChange?.(event);
          },
          onError: (event) => {
            if (disposed || currentGeneration !== generation) return;
            props.onError?.(event);
            configuredEvents.onError?.(event);
          },
        };

        const instance = new window.DocsAPI.DocEditor(props.id, editorConfig);
        if (disposed || currentGeneration !== generation) {
          instance.destroyEditor?.();
          return;
        }
        editorInstance.value = instance;
        window.DocEditor = window.DocEditor || {};
        window.DocEditor.instances = window.DocEditor.instances || {};
        window.DocEditor.instances[props.id] = instance;
      } catch (error) {
        if (disposed || currentGeneration !== generation) return;
        console.error('[OnlyOffice] editor creation failed', error);
        props.onError?.({ data: { errorCode: -2, errorDescription: error.message } });
      }
    };

    onMounted(() => buildEditor(props.config));
    watch(() => props.config, (config) => buildEditor(config));
    onBeforeUnmount(() => {
      disposed = true;
      generation += 1;
      destroyEditor();
    });

    expose({
      editorInstance: () => editorInstance.value,
      reload: () => buildEditor(props.config),
    });

    return { host };
  },
};
</script>

<style scoped>
.onlyoffice-editor-host,
.onlyoffice-editor-target {
  width: 100%;
  height: 100%;
  min-height: 0;
}
</style>
