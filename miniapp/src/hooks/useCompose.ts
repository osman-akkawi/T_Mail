import { useEmailStore } from "../store/emailStore";

export function useCompose() {
  const {
    composeData,
    setComposeData,
    sendEmail,
    saveDraft,
    isComposing,
    setComposing,
  } = useEmailStore();

  return {
    composeData,
    setComposeData,
    sendEmail,
    saveDraft,
    isComposing,
    setComposing,
  };
}
