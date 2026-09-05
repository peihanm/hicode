import type {TaskNotification, TaskSessionLike} from "../tasks/index.js";
import type {RuntimeMessageQueue} from "./messageQueue.js";

/** Admission belongs to the Session queue; ACK follows its durable snapshot. */
export function createTaskNotificationDelivery(input: {
    tasks: Pick<TaskSessionLike, "pendingNotifications" | "acknowledgeNotification">;
    queue: RuntimeMessageQueue;
    persist(): Promise<void>;
    onQueued(notification: TaskNotification): void;
}) {
    let active: Promise<void> | undefined;
    let requested = false;
    return {
        drain(): Promise<void> {
            requested = true;
            if (active) return active;
            const operation = (async () => {
                do {
                    requested = false;
                    const notifications = await input.tasks.pendingNotifications();
                    input.queue.pruneTaskReceipts(new Set(notifications.map(notification => notification.notificationId)));
                    for (const notification of notifications) {
                        if (input.queue.enqueueTask(notification)) input.onQueued(notification);
                        await input.persist();
                        await input.tasks.acknowledgeNotification(notification);
                    }
                } while (requested);
            })();
            active = operation;
            void operation.then(() => { active = undefined; }, () => { active = undefined; });
            return operation;
        },
    };
}
