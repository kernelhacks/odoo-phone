from odoo import api, fields, models


class ResUsers(models.Model):
    _inherit = "res.users"

    sip_account_ids = fields.One2many(
        "phone.sip.account",
        "user_id",
        string="SIP Accounts",
        help="SIP/WebRTC accounts linked to this user.",
    )
    sip_extension = fields.Char(
        string="Primary SIP Extension",
        compute="_compute_sip_extension",
        help="Shortcut to the enabled SIP extension used by the webphone.",
        store=False,
    )

    @api.depends("sip_account_ids", "sip_account_ids.enabled", "sip_account_ids.extension")
    def _compute_sip_extension(self):
        for user in self:
            account = user._get_primary_sip_account()
            user.sip_extension = account.extension if account else False

    def _get_primary_sip_account(self):
        self.ensure_one()
        accounts = self.sudo().sip_account_ids
        enabled = accounts.filtered("enabled")
        return (enabled or accounts)[:1]

    def get_my_webphone_config(self):
        """Used by the web client to obtain the SIP payload."""
        self.ensure_one()
        account = self._get_primary_sip_account()
        if not account or not account.enabled:
            return {
                "has_account": False,
                "account": {},
            }
        payload = account.to_webphone_payload()
        payload.update(
            {
                "user_display_name": self.display_name,
                "email": self.email or "",
            }
        )
        return {
            "has_account": True,
            "account": payload,
        }
