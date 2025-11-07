/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

import {
    PhoneField as BasePhoneField,
    phoneField as basePhoneField,
    formPhoneField as baseFormPhoneField,
} from "@web/views/fields/phone/phone_field";

class WebphonePhoneField extends BasePhoneField {
    static template = "phone.WebphonePhoneField";

    setup() {
        super.setup();
        this.webphone = useService("webphone");
    }

    onSoftphoneCall(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const number = this.props.record.data[this.props.name];
        if (number) {
            this.webphone.callNumber(number);
        } else {
            this.webphone.togglePanel();
        }
    }
}

const webphoneField = {
    ...basePhoneField,
    component: WebphonePhoneField,
};

registry.category("fields").add("phone", webphoneField, { force: true });
registry
    .category("fields")
    .add("form.phone", { ...baseFormPhoneField, component: WebphonePhoneField }, { force: true });
