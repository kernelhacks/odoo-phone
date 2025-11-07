/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

import { WebphonePanel } from "./webphone_panel";

export class WebphoneSystray extends Component {
    static template = "phone.WebphoneSystray";
    static components = { WebphonePanel };

    setup() {
        this.webphone = useService("webphone");
        this.state = useState(this.webphone.state);
    }

    async togglePanel(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        await this.webphone.togglePanel();
    }
}

registry
    .category("systray")
    .add("phone.webphone_systray", { Component: WebphoneSystray }, { sequence: 110 });
