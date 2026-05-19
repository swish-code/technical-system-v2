import { API_URL, getAuthToken } from "./utils";

export type PushSubscriptionStatus = "unsupported" | "denied" | "subscribed" | "error";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

export async function subscribeToPush(): Promise<PushSubscriptionStatus> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      return "unsupported";
    }

    if (Notification.permission === "denied") {
      return "denied";
    }

    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return "denied";
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      const vapidRes = await fetch(`${API_URL}/notifications/vapid-public-key`);
      if (!vapidRes.ok) {
        throw new Error(`Failed to fetch VAPID public key: ${vapidRes.status} ${vapidRes.statusText}`);
      }
      const vapidData = await vapidRes.json() as { publicKey?: string };
      if (!vapidData.publicKey || vapidData.publicKey.trim() === "") {
        throw new Error("Missing VAPID public key");
      }

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey),
      });
    }

    const token = getAuthToken();
    if (!token) return "error";

    const saveRes = await fetch(`${API_URL}/notifications/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(subscription),
    });

    if (!saveRes.ok) {
      throw new Error(`Failed to save push subscription: ${saveRes.status} ${saveRes.statusText}`);
    }
    return "subscribed";
  } catch (error) {
    console.error("Push subscribe error:", error);
    return "error";
  }
}
