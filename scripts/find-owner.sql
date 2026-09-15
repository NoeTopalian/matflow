SELECT u.email, u.role
FROM "User" u
INNER JOIN "Tenant" t ON u."tenantId" = t.id
WHERE t.slug = 'totalbjj' AND u.role = 'owner'
LIMIT 3;
