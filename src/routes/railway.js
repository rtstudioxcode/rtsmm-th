import { Router } from "express";
import axios from "axios";
const router = Router();

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || "bafd63e9-6c18-4760-8c40-1251592552c2";
const PROJECT_ID = "6676f236-5084-43a0-bdc6-6902c088ac4d";

async function railwayQuery(query, variables = {}) {
    try {
        const response = await axios.post(RAILWAY_API_URL, { query, variables }, {
            headers: {
                'Authorization': `Bearer ${RAILWAY_TOKEN}`,
                'Content-Type': 'application/json',
            }
        });
        return response.data;
    } catch (error) {
        console.error('Railway API Connection Error:', error.message);
        throw error;
    }
}

// ดึงข้อมูล Deployment และ Service ID โดยใช้ TENANTID
router.get('/service-info/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        console.log(`Searching for Tenant: ${tenantId}`);

        const query = `
            query GetProject($id: String!) {
                project(id: $id) {
                    services {
                        edges {
                            node {
                                id
                                name
                                serviceInstances {
                                    edges {
                                        node {
                                            environmentId
                                            variables
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;

        const result = await railwayQuery(query, { id: PROJECT_ID });
        const services = result.data?.project?.services?.edges || [];
        
        // ค้นหา Service ที่มี TENANTID ตรงกัน (แบบไม่สนตัวพิมพ์เล็ก-ใหญ่)
        const target = services.find(edge => {
            const instance = edge.node.serviceInstances.edges[0]?.node;
            const vars = instance?.variables || {};
            const railwayTenant = vars.TENANTID || vars.tenantId;
            return railwayTenant && railwayTenant.toUpperCase() === tenantId.toUpperCase();
        });

        if (!target) return res.status(404).json({ error: "ไม่พบ Service ใน Railway" });

        const serviceId = target.node.id;
        const envId = target.node.serviceInstances.edges[0]?.node?.environmentId;

        // ดึง Deployment ล่าสุด
        const deployQuery = `
            query GetLatest($serviceId: String!) {
                service(id: $serviceId) {
                    deployments(first: 1) {
                        edges { node { id status } }
                    }
                }
            }
        `;
        const dResult = await railwayQuery(deployQuery, { serviceId });
        const latest = dResult.data?.service?.deployments?.edges[0]?.node;

        res.json({
            serviceId,
            environmentId: envId,
            deploymentId: latest?.id,
            status: latest?.status
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ดึง Logs
router.get('/logs/deploy/:deploymentId', async (req, res) => {
    try {
        const query = `
            query GetLogs($id: String!) {
                deploymentLogs(deploymentId: $id, limit: 150) { message timestamp }
            }
        `;
        const data = await railwayQuery(query, { id: req.params.deploymentId });
        res.json(data.data?.deploymentLogs || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// สั่ง Restart (Redeploy)
router.post('/restart', async (req, res) => {
    try {
        const { serviceId, environmentId } = req.body;
        const mutation = `
            mutation Redeploy($sId: String!, $eId: String!) {
                serviceInstanceRedeploy(serviceId: $sId, environmentId: $eId)
            }
        `;
        const result = await railwayQuery(mutation, { sId: serviceId, eId: environmentId });
        res.json({ ok: true, data: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;