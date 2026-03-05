import type { OpenClawConfig } from "../../../config/config.js";
import { createActionGate } from "../../../agents/tools/common.js";

function isWhatsAppEnabled(cfg: OpenClawConfig): boolean {
  return cfg.channels?.whatsapp?.enabled !== false;
}

export const whatsappMessageActions = {
  listActions: ({ cfg }: { cfg: OpenClawConfig }): string[] => {
    if (!isWhatsAppEnabled(cfg)) return [];
    const gate = createActionGate(cfg.channels?.whatsapp?.actions);
    const actions = new Set(["send"]);
    if (gate("polls")) actions.add("poll");
    if (gate("reactions")) actions.add("react");
    if (gate("pin")) {
      actions.add("pin");
      actions.add("unpin");
    }
    if (gate("setProfilePicture")) {
      actions.add("setProfilePicture");
      actions.add("clearProfilePicture");
    }
    if (gate("setGroupIcon")) {
      actions.add("setGroupIcon");
    }
    return Array.from(actions);
  },
};
