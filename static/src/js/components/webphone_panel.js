/** @odoo-module **/

import { Component, onMounted, useRef, useState } from "@odoo/owl";
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
        onMounted(() => {
            this.webphone.setAudioElement(this.remoteAudio.el);
        });
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
}
