/** @odoo-module **/

import { Component, onMounted, useEffect, useExternalListener, useRef, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class WebphonePanel extends Component {
    static props = {
        floating: { type: Boolean, optional: true },
    };
    static template = "phone.WebphonePanel";

    setup() {
        this.webphone = useService("webphone");
        this.state = useState(this.webphone.state);
        this.remoteAudio = useRef("remoteAudio");
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
        onMounted(() => {
            this.webphone.setAudioElement(this.remoteAudio.el);
        });
        useEffect(
            () => {
                if (this.state.callStatus !== "incoming" && this.bannerDrag.manual) {
                    this.resetBannerPosition();
                }
            },
            () => [this.state.callStatus]
        );
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

    onDialInput(ev) {
        this.webphone.updateDialNumber(ev.target.value);
    }

    onAddDigit(digit) {
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
}
