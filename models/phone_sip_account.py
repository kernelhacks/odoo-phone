from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class PhoneSipAccount(models.Model):
    _name = "phone.sip.account"
    _description = "SIP Account"
    _order = "extension"

    name = fields.Char(
        string="Label",
        required=True,
        help="Friendly label for this SIP account. Defaults to the extension.",
    )
    user_id = fields.Many2one(
        "res.users",
        string="Assigned User",
        required=True,
        ondelete="cascade",
        help="User that will authenticate with this SIP account.",
    )
    extension = fields.Char(
        string="Extension",
        required=True,
        help="Numeric or alphanumeric SIP extension exposed to PBX users.",
    )
    auth_username = fields.Char(
        string="Auth Username",
        required=True,
        help="Username credential sent to the SIP registrar. Often it matches the extension.",
    )
    auth_password = fields.Char(
        string="Auth Password",
        required=True,
        help="Secret used to authenticate the SIP account.",
    )
    sip_domain = fields.Char(
        string="SIP Domain / Registrar",
        required=True,
        help="Domain name or IP of the SIP registrar (e.g. pbx.example.com).",
    )
    sip_websocket_uri = fields.Char(
        string="WebSocket URI",
        required=True,
        help="wss:// endpoint exposed by the PBX or SBC that speaks WebRTC (e.g. wss://pbx.example.com:8089/ws).",
    )
    outbound_proxy = fields.Char(
        string="Outbound Proxy",
        help="Optional outbound proxy used by the SIP client.",
    )
    stun_server = fields.Char(
        string="STUN Server",
        help="Optional STUN server used for ICE negotiation (e.g. stun:stun.l.google.com:19302).",
    )
    turn_server = fields.Char(
        string="TURN Server",
        help="Optional TURN server definition if relaying media is required.",
    )
    turn_username = fields.Char(
        string="TURN Username",
        help="TURN credential username.",
    )
    turn_password = fields.Char(
        string="TURN Password",
        help="TURN credential password.",
    )
    enabled = fields.Boolean(
        string="Enabled",
        default=True,
        help="Only enabled SIP accounts are exposed to the webphone.",
    )

    _sql_constraints = [
        (
            "phone_sip_account_extension_unique",
            "unique(extension)",
            "Each SIP extension must be unique.",
        ),
        (
            "phone_sip_account_user_unique",
            "unique(user_id)",
            "Each user can only own a single SIP account.",
        ),
    ]

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if not vals.get("name") and vals.get("extension"):
                vals["name"] = vals["extension"]
        return super().create(vals_list)

    @api.constrains("sip_websocket_uri")
    def _check_ws_uri(self):
        for account in self:
            uri = account.sip_websocket_uri or ""
            if uri and not uri.startswith(("ws://", "wss://")):
                raise ValidationError(
                    _("WebSocket URI must start with ws:// or wss:// (value: %s).")
                    % uri
                )

    def name_get(self):
        result = []
        for account in self:
            name = "%s (%s)" % (account.name, account.extension)
            result.append((account.id, name))
        return result

    def to_webphone_payload(self):
        """Prepare the configuration payload expected by the web client."""
        self.ensure_one()
        return {
            "id": self.id,
            "label": self.name,
            "extension": self.extension,
            "auth_username": self.auth_username,
            "auth_password": self.auth_password,
            "domain": self.sip_domain,
            "ws_uri": self.sip_websocket_uri,
            "outbound_proxy": self.outbound_proxy or "",
            "stun_server": self.stun_server or "",
            "turn_server": self.turn_server or "",
            "turn_username": self.turn_username or "",
            "turn_password": self.turn_password or "",
        }
