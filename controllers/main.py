from odoo import http
from odoo.http import request


class PhoneWebphoneController(http.Controller):
    @http.route("/phone/webphone/config", type="jsonrpc", auth="user")
    def phone_webphone_config(self):
        user = request.env.user
        return user.get_my_webphone_config()
