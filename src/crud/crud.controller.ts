import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { CrudService, ListQuery } from "./crud.service";
import { RESOURCES } from "./resource-registry";

const RESOURCE_LIST = Object.keys(RESOURCES).join(", ");

/**
 * Generic tenant-scoped REST endpoints matching the frontend convention
 * `/api/{tenant.slug}/{resource}` (see frontend README §"Swapping in a real
 * backend"). Resource slugs are defined in resource-registry.ts. Nested
 * collections (order items, shipment events, packing cartons…) are stored
 * relationally and composed into the payloads automatically.
 */
@ApiTags("resources")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug (e.g. volt, nord, agri)" })
@ApiParam({ name: "resource", description: `One of: ${RESOURCE_LIST}` })
@Controller("api/:tenant/:resource")
@UseGuards(TenantGuard)
export class CrudController {
  constructor(private readonly crud: CrudService) {}

  @Get()
  @ApiOperation({
    summary: "List records",
    description:
      "Paginated list. Any column name (camelCase) can be passed as an equality filter, e.g. ?status=active.",
  })
  @ApiQuery({ name: "q", required: false, description: "Free-text search over the resource's searchable columns" })
  @ApiQuery({ name: "page", required: false, description: "1-based page number (default 1)" })
  @ApiQuery({ name: "pageSize", required: false, description: "Rows per page (default 50, max 200)" })
  @ApiQuery({ name: "sort", required: false, description: 'Column to sort by, prefix "-" for descending' })
  list(@CurrentTenant() tenant: TenantDto, @Param("resource") resource: string, @Query() query: ListQuery) {
    return this.crud.list(tenant, resource, query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get one record by id (includes nested child collections)" })
  get(@CurrentTenant() tenant: TenantDto, @Param("resource") resource: string, @Param("id") id: string) {
    return this.crud.get(tenant, resource, id);
  }

  @Post()
  @ApiOperation({
    summary: "Create a record",
    description:
      "Body fields map to the frontend types (src/lib/types.ts). Nested arrays (items, images, events…) are persisted to child tables.",
  })
  @ApiBody({ description: "Resource payload — see the frontend type of the same name" })
  create(@CurrentTenant() tenant: TenantDto, @Param("resource") resource: string, @Body() body: Record<string, unknown>) {
    return this.crud.create(tenant, resource, body);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update a record (partial)",
    description: "Only provided fields change. A provided nested array replaces that child collection entirely.",
  })
  patch(
    @CurrentTenant() tenant: TenantDto,
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crud.update(tenant, resource, id, body);
  }

  @Put(":id")
  @ApiOperation({ summary: "Update a record (alias of PATCH)" })
  put(
    @CurrentTenant() tenant: TenantDto,
    @Param("resource") resource: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crud.update(tenant, resource, id, body);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a record (child rows cascade)" })
  remove(@CurrentTenant() tenant: TenantDto, @Param("resource") resource: string, @Param("id") id: string) {
    return this.crud.remove(tenant, resource, id);
  }
}
