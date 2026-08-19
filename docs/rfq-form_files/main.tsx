const StrictMode = __vite__cjsImport0_react["StrictMode"];const createRoot = __vite__cjsImport1_reactDom_client["createRoot"];const _jsxDEV = __vite__cjsImport9_react_jsxDevRuntime["jsxDEV"];import __vite__cjsImport0_react from "/node_modules/.vite/deps/react.js?v=c3bd0926";
import __vite__cjsImport1_reactDom_client from "/node_modules/.vite/deps/react-dom_client.js?v=c3bd0926";
import "/src/index.css?t=1787141278274";
import App from "/src/App.tsx?t=1787141278274";
import { ToastProvider } from "/src/components/Toast.tsx";
import ErrorBoundary from "/src/components/ErrorBoundary.tsx";
import { maybeHydrateOffline } from "/src/lib/offlineSnapshot.ts";
import { captureError } from "/src/utils/errorMonitoring.ts";
import { emit } from "/src/lib/emit.ts";
var _jsxFileName = "C:/Users/Imart/scm/UC1-AND-UC2/src/main.tsx";
import __vite__cjsImport9_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=c3bd0926";
// P4: if this is a downloaded offline HTML (window.__EMBEDDED_PULL present), seed the module state from the baked-in
// snapshot BEFORE React renders — so the dashboard hydrates from captured data with no network/LLM. No-op otherwise.
maybeHydrateOffline();
// Fixes P1-116: async failures (outside React render) had no handler and no telemetry. Record them globally.
window.addEventListener("error", (e) => {
	captureError("NETWORK_ERROR", e.message || "window.error", e.filename);
	emit("rfq_window_error", { message: String(e.message || "").slice(0, 160) });
});
window.addEventListener("unhandledrejection", (e) => {
	const m = e.reason instanceof Error ? e.reason.message : String(e.reason);
	captureError("NETWORK_ERROR", m, "unhandledrejection");
	emit("rfq_unhandled_rejection", { message: m.slice(0, 160) });
});
createRoot(document.getElementById("root")).render(/* @__PURE__ */ _jsxDEV(StrictMode, { children: /* @__PURE__ */ _jsxDEV(ErrorBoundary, { children: /* @__PURE__ */ _jsxDEV(ToastProvider, { children: /* @__PURE__ */ _jsxDEV(App, {}, void 0, false, {
	fileName: _jsxFileName,
	lineNumber: 24,
	columnNumber: 9
}, this) }, void 0, false, {
	fileName: _jsxFileName,
	lineNumber: 23,
	columnNumber: 7
}, this) }, void 0, false, {
	fileName: _jsxFileName,
	lineNumber: 22,
	columnNumber: 5
}, this) }, void 0, false, {
	fileName: _jsxFileName,
	lineNumber: 21,
	columnNumber: 3
}, this));

//# sourceMappingURL=data:application/json;base64,eyJtYXBwaW5ncyI6IkFBQ0EsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxrQkFBa0I7QUFDM0IsT0FBTztBQUNQLE9BQU8sU0FBUztBQUNoQixTQUFTLHFCQUFxQjtBQUM5QixPQUFPLG1CQUFtQjtBQUMxQixTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFlBQVk7Ozs7O0FBSXJCLG9CQUFvQjs7QUFHcEIsT0FBTyxpQkFBaUIsVUFBVSxNQUFNO0NBQUUsYUFBYSxpQkFBaUIsRUFBRSxXQUFXLGdCQUFnQixFQUFFLFFBQVE7Q0FBRyxLQUFLLG9CQUFvQixFQUFFLFNBQVMsT0FBTyxFQUFFLFdBQVcsRUFBRSxFQUFFLE1BQU0sR0FBRyxHQUFHLEVBQUUsQ0FBQztBQUFHLENBQUM7QUFDak0sT0FBTyxpQkFBaUIsdUJBQXVCLE1BQU07Q0FBRSxNQUFNLElBQUksRUFBRSxrQkFBa0IsUUFBUSxFQUFFLE9BQU8sVUFBVSxPQUFPLEVBQUUsTUFBTTtDQUFHLGFBQWEsaUJBQWlCLEdBQUcsb0JBQW9CO0NBQUcsS0FBSywyQkFBMkIsRUFBRSxTQUFTLEVBQUUsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDO0FBQUcsQ0FBQztBQUUxUCxXQUFXLFNBQVMsZUFBZSxNQUFNLENBQUUsRUFBRSxPQUMzQyx3QkFBQyxZQUFELFlBQ0Usd0JBQUMsZUFBRCxZQUNFLHdCQUFDLGVBQUQsWUFDRSx3QkFBQyxLQUFELENBQU07Ozs7U0FDTzs7OztTQUNGOzs7O1NBQ0w7Ozs7UUFDZCIsIm5hbWVzIjpbXSwic291cmNlcyI6WyJtYWluLnRzeCJdLCJ2ZXJzaW9uIjozLCJzb3VyY2VzQ29udGVudCI6WyJcclxuaW1wb3J0IHsgU3RyaWN0TW9kZSB9IGZyb20gJ3JlYWN0JztcclxuaW1wb3J0IHsgY3JlYXRlUm9vdCB9IGZyb20gJ3JlYWN0LWRvbS9jbGllbnQnO1xyXG5pbXBvcnQgJy4vaW5kZXguY3NzJztcclxuaW1wb3J0IEFwcCBmcm9tICcuL0FwcCc7XHJcbmltcG9ydCB7IFRvYXN0UHJvdmlkZXIgfSBmcm9tICcuL2NvbXBvbmVudHMvVG9hc3QnO1xyXG5pbXBvcnQgRXJyb3JCb3VuZGFyeSBmcm9tICcuL2NvbXBvbmVudHMvRXJyb3JCb3VuZGFyeSc7XHJcbmltcG9ydCB7IG1heWJlSHlkcmF0ZU9mZmxpbmUgfSBmcm9tICcuL2xpYi9vZmZsaW5lU25hcHNob3QnO1xyXG5pbXBvcnQgeyBjYXB0dXJlRXJyb3IgfSBmcm9tICcuL3V0aWxzL2Vycm9yTW9uaXRvcmluZyc7XHJcbmltcG9ydCB7IGVtaXQgfSBmcm9tICcuL2xpYi9lbWl0JztcclxuXHJcbi8vIFA0OiBpZiB0aGlzIGlzIGEgZG93bmxvYWRlZCBvZmZsaW5lIEhUTUwgKHdpbmRvdy5fX0VNQkVEREVEX1BVTEwgcHJlc2VudCksIHNlZWQgdGhlIG1vZHVsZSBzdGF0ZSBmcm9tIHRoZSBiYWtlZC1pblxyXG4vLyBzbmFwc2hvdCBCRUZPUkUgUmVhY3QgcmVuZGVycyDigJQgc28gdGhlIGRhc2hib2FyZCBoeWRyYXRlcyBmcm9tIGNhcHR1cmVkIGRhdGEgd2l0aCBubyBuZXR3b3JrL0xMTS4gTm8tb3Agb3RoZXJ3aXNlLlxyXG5tYXliZUh5ZHJhdGVPZmZsaW5lKCk7XHJcblxyXG4vLyBGaXhlcyBQMS0xMTY6IGFzeW5jIGZhaWx1cmVzIChvdXRzaWRlIFJlYWN0IHJlbmRlcikgaGFkIG5vIGhhbmRsZXIgYW5kIG5vIHRlbGVtZXRyeS4gUmVjb3JkIHRoZW0gZ2xvYmFsbHkuXHJcbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsIChlKSA9PiB7IGNhcHR1cmVFcnJvcignTkVUV09SS19FUlJPUicsIGUubWVzc2FnZSB8fCAnd2luZG93LmVycm9yJywgZS5maWxlbmFtZSk7IGVtaXQoJ3JmcV93aW5kb3dfZXJyb3InLCB7IG1lc3NhZ2U6IFN0cmluZyhlLm1lc3NhZ2UgfHwgJycpLnNsaWNlKDAsIDE2MCkgfSk7IH0pO1xyXG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigndW5oYW5kbGVkcmVqZWN0aW9uJywgKGUpID0+IHsgY29uc3QgbSA9IGUucmVhc29uIGluc3RhbmNlb2YgRXJyb3IgPyBlLnJlYXNvbi5tZXNzYWdlIDogU3RyaW5nKGUucmVhc29uKTsgY2FwdHVyZUVycm9yKCdORVRXT1JLX0VSUk9SJywgbSwgJ3VuaGFuZGxlZHJlamVjdGlvbicpOyBlbWl0KCdyZnFfdW5oYW5kbGVkX3JlamVjdGlvbicsIHsgbWVzc2FnZTogbS5zbGljZSgwLCAxNjApIH0pOyB9KTtcclxuXHJcbmNyZWF0ZVJvb3QoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSEpLnJlbmRlcihcclxuICA8U3RyaWN0TW9kZT5cclxuICAgIDxFcnJvckJvdW5kYXJ5PlxyXG4gICAgICA8VG9hc3RQcm92aWRlcj5cclxuICAgICAgICA8QXBwIC8+XHJcbiAgICAgIDwvVG9hc3RQcm92aWRlcj5cclxuICAgIDwvRXJyb3JCb3VuZGFyeT5cclxuICA8L1N0cmljdE1vZGU+LFxyXG4pO1xyXG4iXX0=