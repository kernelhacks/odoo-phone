/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

import { WebphonePanel } from "./components/webphone_panel";

class WebphoneClientAction extends Component {
    static template = "phone.WebphoneClientAction";
    static components = { WebphonePanel };

    setup() {
        this.webphone = useService("webphone");
        this.state = useState(this.webphone.state);
        this.webphone.ensureInitialized();
        this.state.panelOpen = true;
    }
}

registry.category("actions").add("phone.webphone_client_action", WebphoneClientAction);
