/** @odoo-module **/

import {
    Component,
    onMounted,
    onWillUnmount,
    useEffect,
    useExternalListener,
    useRef,
    useState,
} from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

const DTMF_FREQUENCIES = {
    "1": [697, 1209],
    "2": [697, 1336],
    "3": [697, 1477],
    "4": [770, 1209],
    "5": [770, 1336],
    "6": [770, 1477],
    "7": [852, 1209],
    "8": [852, 1336],
    "9": [852, 1477],
    "*": [941, 1209],
    "0": [941, 1336],
    "#": [941, 1477],
};

export class WebphonePanel extends Component {
    static props = {
        floating: { type: Boolean, optional: true },
    };
    static template = "phone.WebphonePanel";

    setup() {
        this.webphone = useService("webphone");
        this.state = useState(this.webphone.state);
        this.remoteAudio = useRef("remoteAudio");
        this.conferenceAudio = useRef("conferenceAudio");
        this.incomingAudio = useRef("incomingAudio");
        this.bannerRef = useRef("incomingBanner");
        this.bannerDrag = useState({
            dragging: false,
            manual: false,
            offsetX: 0,
            offsetY: 0,
            pointerId: null,
            x: null,
            y: null,
        });
        this.isIncomingAudioPlaying = false;
        this.toneContext = null;
        this.toneMasterGain = null;
        onMounted(() => {
            this.webphone.setAudioElements(this.remoteAudio.el, this.conferenceAudio.el);
        });
        useEffect(
            () => {
                if (this.state.callStatus !== "incoming" && this.bannerDrag.manual) {
                    this.resetBannerPosition();
                }
            },
            () => [this.state.callStatus]
        );
        useEffect(
            () => {
                if (this.state.callStatus === "incoming" && this.state.incomingRinging) {
                    this.playIncomingTone();
                } else {
                    this.stopIncomingTone();
                }
            },
            () => [this.state.callStatus, this.state.incomingRinging]
        );
        onWillUnmount(() => {
            this.stopIncomingTone();
            this.teardownToneContext();
        });
        if (typeof window !== "undefined") {
            useExternalListener(window, "pointermove", (ev) => this.onBannerPointerMove(ev));
            useExternalListener(window, "pointerup", (ev) => this.onBannerPointerUp(ev));
            useExternalListener(window, "pointercancel", (ev) => this.onBannerPointerUp(ev));
            useExternalListener(window, "blur", () => this.stopBannerDrag());
        }
    }

    async onTogglePanel(ev) {
        ev?.preventDefault();
        ev?.stopPropagation();
        await this.webphone.togglePanel();
    }

    async onPlaceCall(ev) {
        ev.preventDefault();
        await this.webphone.placeCall();
    }

    async onCallNumber(number) {
        await this.webphone.callNumber(number);
    }

    async onAcceptIncoming() {
        await this.webphone.acceptIncoming();
    }

    onRejectIncoming() {
        this.webphone.rejectIncoming();
    }

    onHangup() {
        this.webphone.hangup();
    }

    onTransferCall() {
        this.webphone.transferCall();
    }

    onToggleHold() {
        this.webphone.toggleHold();
    }

    onToggleMute() {
        this.webphone.toggleMute();
    }

    onToggleHistoryPanel() {
        this.webphone.toggleHistoryPanel();
    }

    onStartConference() {
        this.webphone.startConference();
    }

    onEndConference() {
        this.webphone.endConference();
    }

    onStartAttendedTransfer() {
        this.webphone.startAttendedTransfer();
    }

    onCompleteAttendedTransfer() {
        this.webphone.completeAttendedTransfer();
    }

    onCancelAttendedTransfer() {
        this.webphone.cancelAttendedTransfer();
    }

    onDialInput(ev) {
        this.webphone.updateDialNumber(ev.target.value);
    }

    onAddDigit(digit) {
        this.playDtmfTone(digit);
        this.webphone.appendDigit(digit);
    }

    onBackspace() {
        this.webphone.backspaceDigit();
    }

    closePanel(ev) {
        ev?.preventDefault();
        ev?.stopPropagation();
        this.webphone.closePanel();
    }

    toggleMinimize(ev) {
        ev?.preventDefault();
        ev?.stopPropagation();
        this.webphone.toggleMinimized();
    }

    onBannerPointerDown(ev) {
        if ((ev.button && ev.button !== 0) || ev.target.closest(".o_webphone_banner__actions")) {
            return;
        }
        if (!this.bannerRef.el) {
            return;
        }
        ev.preventDefault();
        const rect = this.bannerRef.el.getBoundingClientRect();
        this.bannerDrag.manual = true;
        this.bannerDrag.dragging = true;
        this.bannerDrag.pointerId = ev.pointerId;
        this.bannerDrag.offsetX = ev.clientX - rect.left;
        this.bannerDrag.offsetY = ev.clientY - rect.top;
        this.bannerDrag.x = rect.left;
        this.bannerDrag.y = rect.top;
        this.bannerRef.el.setPointerCapture?.(ev.pointerId);
    }

    onBannerPointerMove(ev) {
        if (!this.bannerDrag.dragging || (this.bannerDrag.pointerId !== null && ev.pointerId !== this.bannerDrag.pointerId)) {
            return;
        }
        ev.preventDefault();
        const nextX = ev.clientX - this.bannerDrag.offsetX;
        const nextY = ev.clientY - this.bannerDrag.offsetY;
        const { x, y } = this.clampBannerPosition(nextX, nextY);
        this.bannerDrag.x = x;
        this.bannerDrag.y = y;
    }

    onBannerPointerUp(ev) {
        if (!this.bannerDrag.dragging || (this.bannerDrag.pointerId !== null && ev.pointerId !== this.bannerDrag.pointerId)) {
            return;
        }
        this.stopBannerDrag();
    }

    stopBannerDrag() {
        if (!this.bannerDrag.dragging) {
            return;
        }
        if (this.bannerRef.el && this.bannerDrag.pointerId !== null) {
            this.bannerRef.el.releasePointerCapture?.(this.bannerDrag.pointerId);
        }
        this.bannerDrag.dragging = false;
        this.bannerDrag.pointerId = null;
    }

    resetBannerPosition() {
        this.stopBannerDrag();
        this.bannerDrag.manual = false;
        this.bannerDrag.x = null;
        this.bannerDrag.y = null;
    }

    clampBannerPosition(x, y) {
        const padding = 12;
        if (typeof window === "undefined" || !this.bannerRef.el) {
            return { x, y };
        }
        const rect = this.bannerRef.el.getBoundingClientRect();
        const width = rect.width || 0;
        const height = rect.height || 0;
        const maxX = Math.max(padding, window.innerWidth - width - padding);
        const maxY = Math.max(padding, window.innerHeight - height - padding);
        return {
            x: Math.min(Math.max(padding, x), maxX),
            y: Math.min(Math.max(padding, y), maxY),
        };
    }

    getBannerInlineStyle() {
        if (!this.bannerDrag.manual || this.bannerDrag.x === null || this.bannerDrag.y === null) {
            return;
        }
        return `top:${this.bannerDrag.y}px;left:${this.bannerDrag.x}px;right:auto;bottom:auto;transform:none;`;
    }

    isBannerDragging() {
        return this.bannerDrag.dragging;
    }

    formatCallDuration(seconds) {
        const totalSeconds = Math.max(0, Math.floor(seconds || 0));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60)
            .toString()
            .padStart(2, "0");
        const secs = (totalSeconds % 60).toString().padStart(2, "0");
        if (hours) {
            return `${hours}:${minutes}:${secs}`;
        }
        return `${minutes}:${secs}`;
    }

    formatHistoryTimestamp(value) {
        if (!value) {
            return "";
        }
        try {
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: "short",
                timeStyle: "short",
            }).format(new Date(value));
        } catch (_error) {
            const date = new Date(value);
            return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
        }
    }

    getCallDirectionIcon(direction) {
        switch (direction) {
            case "outgoing":
                return "fa fa-arrow-up text-danger";
            case "incoming":
                return "fa fa-arrow-down text-success";
            case "transfer":
                return "fa fa-exchange-alt text-warning";
            default:
                return "fa fa-circle text-muted";
        }
    }

    getCallDirectionLabel(direction) {
        if (!direction || direction === "idle") {
            return "Idle";
        }
        return direction.charAt(0).toUpperCase() + direction.slice(1);
    }

    playIncomingTone() {
        const audio = this.incomingAudio.el;
        if (!audio || this.isIncomingAudioPlaying) {
            return;
        }
        audio.currentTime = 0;
        const playPromise = audio.play();
        this.isIncomingAudioPlaying = true;
        if (playPromise?.catch) {
            playPromise.catch(() => {
                this.isIncomingAudioPlaying = false;
            });
        }
    }

    stopIncomingTone() {
        const audio = this.incomingAudio.el;
        if (!audio) {
            this.isIncomingAudioPlaying = false;
            return;
        }
        audio.pause();
        audio.currentTime = 0;
        this.isIncomingAudioPlaying = false;
    }

    ensureToneContext() {
        if (typeof window === "undefined") {
            return null;
        }
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            return null;
        }
        if (!this.toneContext) {
            this.toneContext = new AudioContextClass();
            this.toneMasterGain = this.toneContext.createGain();
            this.toneMasterGain.gain.value = 0.4;
            this.toneMasterGain.connect(this.toneContext.destination);
        }
        if (this.toneContext.state === "suspended") {
            this.toneContext.resume();
        }
        return this.toneContext;
    }

    playDtmfTone(digit) {
        const freqs = DTMF_FREQUENCIES[digit];
        if (!freqs?.length) {
            return;
        }
        const ctx = this.ensureToneContext();
        if (!ctx || !this.toneMasterGain) {
            return;
        }
        const now = ctx.currentTime;
        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.3, now + 0.01);
        gainNode.gain.setTargetAtTime(0.0, now + 0.18, 0.05);
        gainNode.connect(this.toneMasterGain);
        freqs.forEach((freq) => {
            const osc = ctx.createOscillator();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, now);
            osc.connect(gainNode);
            osc.start(now);
            osc.stop(now + 0.25);
            osc.onended = () => {
                osc.disconnect();
            };
        });
        if (typeof window !== "undefined") {
            window.setTimeout(() => {
                gainNode.disconnect();
            }, 300);
        }
    }

    teardownToneContext() {
        if (this.toneContext) {
            this.toneContext.close?.();
            this.toneContext = null;
            this.toneMasterGain = null;
        }
    }
}
