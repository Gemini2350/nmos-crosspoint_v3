/**
 * Runs a callback once a burst has settled: quietMs after the last touch, and
 * at the latest maxWaitMs after the first one. Without that limit a burst that
 * never pauses for quietMs would push the callback out for as long as it lasts.
 */
export class SettleTimer {
    private timer: any = null;
    private firstTouch = 0;

    constructor(private callback: () => void, private quietMs: number, private maxWaitMs: number) {}

    touch(): void {
        const now = Date.now();
        if (this.timer === null) {
            this.firstTouch = now;
        } else {
            clearTimeout(this.timer);
        }
        const left = this.firstTouch + this.maxWaitMs - now;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.callback();
        }, Math.max(0, Math.min(this.quietMs, left)));
    }
}
