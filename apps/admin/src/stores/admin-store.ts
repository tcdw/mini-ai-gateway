import { create } from "zustand";

interface AdminStore {
  gatewayApiKey: string;
  gatewayApiKeyInput: string;
  authRevision: number;
  setGatewayApiKeyInput: (key: string) => void;
  applyGatewayApiKey: () => void;
}

const storedGatewayApiKey =
  localStorage.getItem("mini-ai-gateway.gatewayApiKey") ??
  localStorage.getItem("mini-ai-gateway.adminToken") ??
  "";

export const useAdminStore = create<AdminStore>((set) => ({
  gatewayApiKey: storedGatewayApiKey,
  gatewayApiKeyInput: storedGatewayApiKey,
  authRevision: 0,
  setGatewayApiKeyInput: (key) => set({ gatewayApiKeyInput: key }),
  applyGatewayApiKey: () => set((state) => {
    const key = state.gatewayApiKeyInput.trim();
    localStorage.setItem("mini-ai-gateway.gatewayApiKey", key);
    return {
      gatewayApiKey: key,
      authRevision: state.authRevision + 1,
    };
  }),
}));
